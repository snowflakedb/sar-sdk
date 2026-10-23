/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { EnvHttpProxyAgent } from "undici";
import { createSarClient, SarError, type FetchInit, type SarClientOptions } from "../src/index.js";
import { createConnectionOptions, type AuthProvider } from "../src/auth.js";
import { createFetchClient } from "../src/account-http.js";
import { HttpTransport } from "../src/http.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), destroy: vi.fn() }));
vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    return { destroy: transport.destroy };
  }),
  fetch: transport.fetch,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function observe(promise: Promise<unknown>) {
  const outcome: { settled: boolean; error?: unknown } = { settled: false };
  void promise.then(
    () => {
      outcome.settled = true;
    },
    (error) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
}

function provider() {
  const source: AuthProvider = {
    id: "synthetic",
    async resolve() {
      return {
        target: { account: "test" },
        platform: "serverless",
        async acquire() {
          return { type: "oauth", token: "synthetic-app-token" };
        },
      };
    },
  };
  return createConnectionOptions([source], { environment: "deployed", platform: "serverless" });
}

/** Resolves once the request reaches undici. Headers never arrive. */
function stalledHeaders(): Promise<void> {
  const sent = deferred<void>();
  transport.fetch.mockImplementation((_url, init) => {
    sent.resolve();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  return sent.promise;
}

function streamingResponses(headersAfterMs = 0) {
  transport.fetch.mockImplementation(async (_url, init) => {
    if (headersAfterMs) await new Promise((resolve) => setTimeout(resolve, headersAfterMs));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: synthetic\n\n"));
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
            once: true,
          });
        },
      }),
    );
  });
}

const deadlines = () =>
  vi.mocked(AbortSignal.timeout).mock.calls.map(([milliseconds]) => milliseconds);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(EnvHttpProxyAgent).mockClear();
  transport.fetch.mockReset().mockRejectedValue(new Error("No mocked response configured"));
  transport.destroy.mockReset().mockResolvedValue(undefined);
  // Fake timers cannot reach the internal timer behind Node's AbortSignal.timeout.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Synthetic deadline", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetch deadline", () => {
  it("keeps the 120-second default while the body is read", async () => {
    streamingResponses();
    const client = createSarClient({ connectionOptions: provider() });
    try {
      const response = await client.fetch("/api/v2/stream");
      expect(deadlines()).toEqual([120_000]);
      const body = observe(response.text());
      await vi.advanceTimersByTimeAsync(119_999);
      expect(body.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(body.error).toMatchObject({ name: "TimeoutError" });
    } finally {
      await client.close();
    }
  });

  it("applies timeouts.httpMs to clients, caller views, and standalone fetch clients", async () => {
    streamingResponses();
    const client = createSarClient({
      connectionOptions: provider(),
      timeouts: { httpMs: 600_000 },
    });
    const standalone = createFetchClient(provider(), { timeouts: { httpMs: 600_000 } });
    try {
      const responses = await Promise.all([
        client.fetch("/owner"),
        client.asCaller({ token: "synthetic-caller" }).fetch("/caller"),
        standalone.fetch("/standalone"),
        standalone.asCaller({ token: "synthetic-caller" }).fetch("/standalone-caller"),
      ]);
      expect(deadlines()).toEqual([600_000, 600_000, 600_000, 600_000]);
      const bodies = responses.map((response) => observe(response.text()));
      await vi.advanceTimersByTimeAsync(599_999);
      expect(bodies.filter((body) => body.settled)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      for (const body of bodies) expect(body.error).toMatchObject({ name: "TimeoutError" });
    } finally {
      await Promise.all([client.close(), standalone.close()]);
    }
  });

  it.each([
    { httpMs: undefined, timeoutMs: 900_000 },
    { httpMs: 600_000, timeoutMs: 5_000 },
  ])(
    "lets timeoutMs $timeoutMs replace a client default of $httpMs for one request",
    async ({ httpMs, timeoutMs }) => {
      streamingResponses();
      const client = createSarClient({ connectionOptions: provider(), timeouts: { httpMs } });
      try {
        const init: FetchInit = { timeoutMs };
        const responses = await Promise.all([
          client.fetch("/owner", init),
          client.asCaller({ token: "synthetic-caller" }).fetch("/caller", init),
        ]);
        expect(init).toEqual({ timeoutMs });
        expect(deadlines()).toEqual([timeoutMs, timeoutMs]);
        const bodies = responses.map((response) => observe(response.text()));
        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(bodies.filter((body) => body.settled)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        for (const body of bodies) expect(body.error).toMatchObject({ name: "TimeoutError" });
        await (await client.fetch("/next")).body?.cancel();
        expect(deadlines()).toEqual([timeoutMs, timeoutMs, httpMs ?? 120_000]);
      } finally {
        await client.close();
      }
    },
  );

  it("counts one deadline across waiting for headers and reading the body", async () => {
    streamingResponses(4_000);
    const http = new HttpTransport();
    try {
      const pending = http.fetch("https://transport.invalid/stream", { timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(4_000);
      const reader = (await pending).body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("data: synthetic\n\n");
      const next = observe(reader.read());
      await vi.advanceTimersByTimeAsync(5_999);
      expect(next.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(next.error).toMatchObject({ name: "TimeoutError" });
    } finally {
      await http.close();
    }
  });

  it("reports TIMEOUT when headers miss a per-request deadline", async () => {
    const sent = stalledHeaders();
    const client = createSarClient({
      connectionOptions: provider(),
      timeouts: { httpMs: 600_000 },
    });
    try {
      const outcome = observe(client.fetch("/stalled", { timeoutMs: 5_000 }));
      await sent;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.error).toMatchObject({ code: "TIMEOUT" });
    } finally {
      await client.close();
    }
  });

  it("still combines a long deadline with the caller signal and shutdown", async () => {
    const client = createSarClient({ connectionOptions: provider() });
    try {
      const caller = new AbortController();
      let sent = stalledHeaders();
      const aborted = expect(
        client.fetch("/aborted", { signal: caller.signal, timeoutMs: 3_600_000 }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      await sent;
      caller.abort();
      await aborted;
      sent = stalledHeaders();
      const closed = expect(
        client.fetch("/closed", { timeoutMs: 3_600_000 }),
      ).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      await sent;
      await client.close();
      await closed;
    } finally {
      await client.close();
    }
  });

  it("does not pass timeoutMs to undici", async () => {
    transport.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    const client = createSarClient({ connectionOptions: provider() });
    const http = new HttpTransport();
    try {
      await client.fetch("/api/v2/test", { method: "POST", body: "payload", timeoutMs: 5_000 });
      await http.fetch("https://transport.invalid/resource", { timeoutMs: 5_000 });
      const [url, init] = transport.fetch.mock.calls[0]!;
      expect(new URL(url).pathname).toBe("/api/v2/test");
      expect(init).toMatchObject({ method: "POST", body: "payload", redirect: "error" });
      expect(init).not.toHaveProperty("timeoutMs");
      expect(transport.fetch.mock.calls[1]?.[1]).not.toHaveProperty("timeoutMs");
      expect(deadlines()).toEqual([5_000, 5_000]);
    } finally {
      await Promise.all([client.close(), http.close()]);
    }
  });
});

describe("deadline validation", () => {
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "60000", null];

  it.each(invalid)("rejects timeouts.httpMs %o", (httpMs) => {
    const options = { timeouts: { httpMs } } as unknown as SarClientOptions;
    for (const create of [
      () => createSarClient(options),
      () => createFetchClient(undefined, options),
    ])
      expect(create).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: expect.stringMatching(/^httpMs /),
        }),
      );
  });

  it.each(invalid)("rejects timeoutMs %o before acquiring credentials", async (timeoutMs) => {
    const resolve = vi.fn();
    const client = createSarClient({
      connectionOptions: createConnectionOptions([{ id: "synthetic", resolve }]),
    });
    const standalone = createFetchClient(createConnectionOptions([{ id: "synthetic", resolve }]));
    try {
      const init = { timeoutMs } as unknown as FetchInit;
      for (const scope of [client, client.asCaller({ token: "synthetic-caller" }), standalone])
        await expect(scope.fetch("/api/v2/test", init)).rejects.toMatchObject({
          code: "INVALID_OPTIONS",
          message: expect.stringMatching(/^timeoutMs /),
        });
      expect(resolve).not.toHaveBeenCalled();
      expect(transport.fetch).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), standalone.close()]);
    }
  });

  it("accepts the timer range and treats undefined as absent", async () => {
    transport.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    const client = createSarClient({
      connectionOptions: provider(),
      timeouts: { httpMs: 2_147_483_647 },
    });
    try {
      await client.fetch("/default");
      await client.fetch("/minimum", { timeoutMs: 1 });
      await client.fetch("/absent", { timeoutMs: undefined });
      expect(deadlines()).toEqual([2_147_483_647, 1, 2_147_483_647]);
    } finally {
      await client.close();
    }
  });
});

describe("HTTP failure causes", () => {
  it("keeps a network failure as a cause that inspect() shows and JSON omits", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND synthetic-network-marker"), {
        code: "ENOTFOUND",
      }),
    });
    transport.fetch.mockRejectedValue(failure);
    const client = createSarClient({ connectionOptions: provider() });
    try {
      const error = await client.fetch("/api/v2/test").catch((error) => error);
      expect(error).toBeInstanceOf(SarError);
      expect(error.cause).toBe(failure);
      expect(Object.keys(error)).not.toContain("cause");
      expect(inspect(error)).toContain("getaddrinfo ENOTFOUND synthetic-network-marker");
      expect(error.toJSON()).toEqual({
        name: "SarError",
        code: "HTTP_FAILED",
        message: "HTTP request failed",
      });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("synthetic-network-marker");
    } finally {
      await client.close();
    }
  });

  it("never copies request headers or tokens from the cause into the message or JSON", async () => {
    let failure: unknown;
    transport.fetch.mockImplementation(async (_url, init) => {
      const headers = new Headers(init.headers);
      failure = new TypeError(`${headers.get("authorization")} ${headers.get("x-synthetic")}`);
      throw failure;
    });
    const client = createSarClient({ connectionOptions: provider() });
    try {
      const error = await client
        .fetch("/api/v2/test", { headers: { "x-synthetic": "synthetic-header-value" } })
        .catch((error) => error);
      expect(error).toMatchObject({ code: "HTTP_FAILED" });
      expect(error.cause).toBe(failure);
      expect(String(failure)).toContain("Bearer synthetic-app-token synthetic-header-value");
      const exposed = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
      expect(exposed).not.toContain("synthetic-app-token");
      expect(exposed).not.toContain("synthetic-header-value");
    } finally {
      await client.close();
    }
  });

  it("leaves proxy setting errors, which can quote credentials, without a cause", async () => {
    vi.mocked(EnvHttpProxyAgent).mockImplementationOnce(function () {
      throw Object.assign(new TypeError("Invalid URL"), {
        code: "ERR_INVALID_URL",
        input: "http://user:synthetic-proxy-secret@proxy.invalid:99999",
      });
    });
    const http = new HttpTransport();
    try {
      const error = await http.fetch("https://transport.invalid/resource").catch((error) => error);
      expect(error).toMatchObject({
        code: "HTTP_FAILED",
        message: "HTTP proxy settings are invalid",
      });
      expect(error.cause).toBeUndefined();
      expect(inspect(error)).not.toContain("synthetic-proxy-secret");
      expect(transport.fetch).not.toHaveBeenCalled();
      transport.fetch.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(http.fetch("https://transport.invalid/resource")).resolves.toMatchObject({
        status: 204,
      });
    } finally {
      await http.close();
    }
  });
});

describe("failure precedence", () => {
  it.each([
    { code: "CLIENT_CLOSED", close: true, abort: true, expire: true },
    { code: "ABORTED", close: false, abort: true, expire: true },
    { code: "TIMEOUT", close: false, abort: false, expire: true },
    { code: "HTTP_FAILED", close: false, abort: false, expire: false },
  ])("reports $code when the transport then rejects", async ({ code, close, abort, expire }) => {
    const pendingResponse = deferred<Response>();
    transport.fetch.mockReturnValue(pendingResponse.promise);
    const caller = new AbortController();
    const http = new HttpTransport();
    try {
      const settled = http
        .fetch("https://transport.invalid/resource", { signal: caller.signal, timeoutMs: 1_000 })
        .catch((error) => error);
      if (expire) await vi.advanceTimersByTimeAsync(1_000);
      if (abort) caller.abort(new Error("synthetic-caller-reason"));
      const closing = close ? http.close() : undefined;
      const failure = new TypeError("fetch failed", {
        cause: new Error("synthetic-transport-marker"),
      });
      pendingResponse.reject(failure);
      const error = await settled;
      await closing;
      expect(error).toMatchObject({ code });
      expect(error.cause).toBe(code === "HTTP_FAILED" ? failure : undefined);
      expect(inspect(error).includes("synthetic-transport-marker")).toBe(code === "HTTP_FAILED");
      expect(inspect(error)).not.toContain("synthetic-caller-reason");
    } finally {
      await http.close();
    }
  });
});
