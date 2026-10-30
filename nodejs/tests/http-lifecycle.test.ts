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
import { EnvHttpProxyAgent, fetch as transportFetch } from "undici";
import { HttpTransport } from "../src/core/http.js";

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

let http: HttpTransport;
let deadlines: AbortController[];
beforeEach(() => {
  vi.mocked(EnvHttpProxyAgent).mockClear();
  transport.fetch.mockReset().mockRejectedValue(new Error("No mocked response configured"));
  transport.destroy.mockReset().mockResolvedValue(undefined);
  deadlines = [];
  // Trigger deadlines deterministically without real timers or real HTTP.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  http = new HttpTransport();
});
afterEach(async () => {
  await http.close().catch(() => {});
  vi.restoreAllMocks();
});

function stalledHeaders() {
  transport.fetch.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  );
}

function streamingResponse() {
  let response: Response;
  transport.fetch.mockImplementation(async (_url, init) => {
    response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
            once: true,
          });
        },
      }),
      { headers: { "x-synthetic": "retained" } },
    );
    return response;
  });
  return () => response;
}

describe("HTTP deadline composition", () => {
  it("retains the transport deadline with a caller signal", async () => {
    stalledHeaders();
    const caller = new AbortController();
    const pending = http.fetch("https://transport.invalid/resource", { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
    const signal = transport.fetch.mock.calls[0]?.[1].signal;
    expect(signal).not.toBe(caller.signal);
    deadlines[0]!.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("honors caller cancellation without exposing its reason", async () => {
    stalledHeaders();
    const caller = new AbortController();
    const pending = http.fetch("https://transport.invalid/resource", { signal: caller.signal });
    const rejected = pending.catch((error) => error);
    caller.abort(new Error("synthetic-sensitive-caller-reason"));
    const error = await rejected;
    expect(error).toMatchObject({ code: "ABORTED" });
    expect(inspect(error)).not.toContain("synthetic-sensitive-caller-reason");
    expect(error.cause).toBeUndefined();
  });

  it("does not create a dispatcher for a pre-aborted request", async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(
      http.fetch("https://transport.invalid/resource", { signal: caller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it("validates the caller signal before starting transport", async () => {
    await expect(
      http.fetch("https://transport.invalid/resource", { signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it("keeps the original response and deadline through body consumption", async () => {
    const original = streamingResponse();
    const caller = new AbortController();
    const response = await http.fetch("https://transport.invalid/resource", {
      signal: caller.signal,
    });
    expect(response).toBe(original());
    expect(response.headers.get("x-synthetic")).toBe("retained");
    const body = response.text();
    const rejected = expect(body).rejects.toMatchObject({ name: "TimeoutError" });
    deadlines[0]!.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    await rejected;
  });

  it("keeps caller cancellation attached after headers arrive", async () => {
    streamingResponse();
    const caller = new AbortController();
    const response = await http.fetch("https://transport.invalid/resource", {
      signal: caller.signal,
    });
    const rejected = expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await rejected;
  });

  it("uses the same dispatcher and forbids redirects", async () => {
    transport.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    await http.fetch("https://transport.invalid/one", { redirect: "follow" });
    await http.fetch("https://transport.invalid/two");
    expect(EnvHttpProxyAgent).toHaveBeenCalledOnce();
    expect(transport.fetch.mock.calls[0]?.[1].dispatcher).toBe(
      transport.fetch.mock.calls[1]?.[1].dispatcher,
    );
    expect(transport.fetch.mock.calls[0]?.[1].redirect).toBe("error");
  });

  it("redacts transport errors from the message and JSON but keeps the cause", async () => {
    const failure = new Error("synthetic-sensitive-transport-marker");
    transport.fetch.mockRejectedValue(failure);
    const error = await http.fetch("https://transport.invalid/resource").catch((error) => error);
    expect(error).toMatchObject({ code: "HTTP_FAILED", message: "HTTP request failed" });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(
      "synthetic-sensitive-transport-marker",
    );
    expect(error.cause).toBe(failure);
    expect(Object.keys(error)).not.toContain("cause");
  });
});

describe("HTTP terminal shutdown", () => {
  it("is idempotent even when closed before first use", async () => {
    const closing = http.close();
    expect(http.close()).toBe(closing);
    await closing;
    await expect(http.fetch("https://transport.invalid/resource")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(transport.destroy).not.toHaveBeenCalled();
  });

  it("shares one shutdown promise and immediately forbids further requests", async () => {
    transport.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await http.fetch("https://transport.invalid/resource");
    const destroyed = deferred<void>();
    transport.destroy.mockReturnValue(destroyed.promise);
    const closing = http.close();
    expect(http.close()).toBe(closing);
    await expect(http.fetch("https://transport.invalid/resource")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    expect(transport.destroy).toHaveBeenCalledOnce();
    destroyed.resolve();
    await closing;
    expect(http.close()).toBe(closing);
    expect(EnvHttpProxyAgent).toHaveBeenCalledOnce();
  });

  it("aborts pending requests", async () => {
    stalledHeaders();
    const pending = http.fetch("https://transport.invalid/resource");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await http.close();
    await rejected;
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it("aborts response bodies that are already being consumed", async () => {
    streamingResponse();
    const response = await http.fetch("https://transport.invalid/resource");
    const rejected = expect(response.text()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await http.close();
    await rejected;
  });

  it("aborts unread response bodies too", async () => {
    streamingResponse();
    const response = await http.fetch("https://transport.invalid/resource");
    await http.close();
    await expect(response.text()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("cancels a late response instead of returning it after close", async () => {
    const pendingResponse = deferred<Response>();
    transport.fetch.mockReturnValue(pendingResponse.promise);
    const pending = http.fetch("https://transport.invalid/resource");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await http.close();
    const response = new Response("late synthetic body");
    const cancel = vi.spyOn(response.body!, "cancel");
    pendingResponse.resolve(response);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("remains terminal and sanitizes dispatcher shutdown failures", async () => {
    transport.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await http.fetch("https://transport.invalid/resource");
    transport.destroy.mockRejectedValue(new Error("synthetic-sensitive-shutdown-marker"));
    const closing = http.close();
    const error = await closing.catch((error) => error);
    expect(error).toMatchObject({ code: "HTTP_FAILED" });
    expect(inspect(error)).not.toContain("synthetic-sensitive-shutdown-marker");
    expect(error.cause).toBeUndefined();
    expect(http.close()).toBe(closing);
    await expect(http.fetch("https://transport.invalid/resource")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    expect(transport.destroy).toHaveBeenCalledOnce();
  });
});
