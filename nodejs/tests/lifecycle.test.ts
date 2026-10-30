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

import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, deadline } from "../src/core/lifecycle.js";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/connection-options/index.js";
import { fakeDriver } from "./fake-driver.js";
import type { SarClientOptions } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  fakeOptions: Parameters<typeof fakeDriver>[0] = {},
  options: Pick<SarClientOptions, "connectionOptions" | "pool" | "timeouts" | "results"> = {},
) {
  const fake = fakeDriver(fakeOptions);
  return {
    ...fake,
    client: createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        authenticator: "OAUTH",
        token: "synthetic",
      }),
      ...options,
    }),
  };
}
describe("permit ownership", () => {
  it("does not lose a permit when abort and handoff share a turn", async () => {
    const budget = new Budget(1, 1);
    const release = await budget.acquire(1000);
    const controller = new AbortController();
    const pending = budget.acquire(1000, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    release();
    await rejected;
    expect(budget.active).toBe(0);
    expect(budget.queued).toBe(0);
    (await budget.acquire(1000))();
    expect(budget.active).toBe(0);
  });
  it("conserves permits on timeout and shutdown", async () => {
    vi.useFakeTimers();
    const budget = new Budget(1, 2);
    const release = await budget.acquire(1000);
    const pending = budget.acquire(5);
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    const queued = budget.acquire(1000);
    const closed = expect(queued).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    budget.close();
    release();
    release();
    await closed;
    expect(budget.active).toBe(0);
    expect(budget.queued).toBe(0);
  });
});
describe("operation disposal", () => {
  it("shares destruction across abort, cancel, and forced shutdown", async () => {
    const gate = deferred();
    const controller = new AbortController();
    const { client, connections } = setup({ status: "RUNNING", destroyGate: gate.promise });
    const handle = await client.submit("synthetic", { signal: controller.signal });
    controller.abort();
    const cancel = handle.cancel();
    const closing = client.close({ timeoutMs: 1 });
    const rejected = expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    gate.resolve();
    await cancel;
    await rejected;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
  });
  it("releases a submitted handle after abort without waiting for a consumer", async () => {
    const controller = new AbortController();
    const { client, connections } = setup();
    const handle = await client.submit("synthetic", { signal: controller.signal });
    controller.abort();
    try {
      await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
      expect(connections[0]?.cancel).toHaveBeenCalledOnce();
      expect((await client.diagnostics()).activeConnections).toBe(0);
      await expect(handle.result()).rejects.toMatchObject({ code: "ABORTED" });
    } finally {
      await client.close();
    }
  });
  it("retains observed success when result waiting is already aborted", async () => {
    const { client, connections } = setup();
    const handle = await client.submit("synthetic");
    expect(await handle.status()).toBe("SUCCESS");
    await expect(handle.result({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ABORTED",
      details: { completion: "succeeded" },
    });
    expect(await handle.status()).toBe("SUCCESS");
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    await client.close();
  });
  it("retains terminal success after explicit disposal", async () => {
    const { client, connections } = setup();
    const handle = await client.submit("synthetic");
    await handle.result();
    await handle.cancel();
    const calls = connections[0]!.getQueryStatus.mock.calls.length;
    expect(await handle.status()).toBe("SUCCESS");
    expect(connections[0]?.getQueryStatus).toHaveBeenCalledTimes(calls);
    await client.close();
  });
  it("does not log in after expiring while queued behind another driver login", async () => {
    const gate = deferred();
    const { client, connections } = setup(
      { connectGate: gate.promise },
      {
        connectionOptions: createConnectionOptions({
          account: "test",
          username: "synthetic",
          authenticator: "OAUTH_CLIENT_CREDENTIALS",
          oauthClientId: "synthetic",
          oauthClientSecret: "synthetic",
        }),
      },
    );
    const first = client.query("first", { authTimeoutMs: 10_000 });
    await vi.waitFor(() => expect(connections[0]?.connect).toHaveBeenCalledOnce());
    const second = client.query("second", { authTimeoutMs: 200 });
    // The first login holds the queue, so the deadline expires while the second waits in it.
    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    gate.resolve();
    await first;
    // The pool builds the second connection only when its turn comes, so it never existed.
    expect(connections).toHaveLength(1);
    await client.close();
  });
  it("does not dispatch user SQL after initialization is aborted", async () => {
    const controller = new AbortController();
    const { client, connections } = setup({ afterInitialization: () => controller.abort() });
    await expect(client.query("user-sql", { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(connections[0]?.execute).toHaveBeenCalledOnce();
    await client.close();
  });
  it("rejects pending result retrieval on handle cancellation", async () => {
    const gate = deferred();
    const { client, connections } = setup({ fetchGate: gate.promise });
    const handle = await client.submit("synthetic");
    const result = handle.result();
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    await handle.cancel();
    gate.resolve();
    await rejected;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("allows existing handles to finish during graceful shutdown", async () => {
    const { client } = setup();
    const handle = await client.submit("synthetic");
    const closing = client.close();
    expect((await handle.result()).rowCount).toBe(1);
    await closing;
  });
  it("destroys active row streams when shutdown forces cleanup", async () => {
    const readable = new Readable({ objectMode: true, read() {} });
    const { client } = setup({ readable });
    const stream = await client.stream("synthetic");
    const pending = stream[Symbol.asyncIterator]().next();
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await expect(client.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(readable.destroyed).toBe(true);
  });
  it("makes repeated stream close await the same destruction", async () => {
    const gate = deferred();
    const { client, connections } = setup({ destroyGate: gate.promise });
    const stream = await client.stream("synthetic");
    const first = stream.close();
    const second = stream.close();
    expect(first).toBe(second);
    gate.resolve();
    await second;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("preserves application errors when driver destruction also fails", async () => {
    const { client } = setup({ destroyError: Error("driver-private") });
    const primary = Error("application error");
    await expect(
      client.withConnection(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    await client.close();
  });
  it("redacts stream errors while retaining query identity", async () => {
    const readable = new Readable({
      objectMode: true,
      read() {
        this.destroy(Error("driver-private"));
      },
    });
    const { client } = setup({ readable });
    const stream = await client.stream("synthetic");
    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((error) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      details: { queryId: "query-1", completion: "succeeded" },
    });
    expect(JSON.stringify(error)).not.toContain("driver-private");
    await client.close();
  });
  it("does not let explicit undefined remove result limits", async () => {
    const { client } = setup({}, { results: { maxBytes: 1 } });
    await expect(client.query("synthetic", { maxBytes: undefined })).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
    await client.close();
  });
  it.each([
    null,
    { pool: true },
    { timeouts: [] },
    { auth: { profileEnvironmentOverrides: "false" } },
    { timeouts: { waitMs: 2 ** 32 } },
  ])("rejects malformed client settings %o", (options) => {
    expect(() => createSarClient(options as unknown as SarClientOptions)).toThrow();
  });
});

describe("absolute deadlines", () => {
  it("skips expired queued login even before its timeout callback runs", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const gate = deferred();
    const { client, connections } = setup(
      { connectGate: gate.promise },
      {
        connectionOptions: createConnectionOptions({
          account: "test",
          username: "synthetic",
          authenticator: "OAUTH_CLIENT_CREDENTIALS",
          oauthClientId: "synthetic",
          oauthClientSecret: "synthetic",
        }),
      },
    );
    const first = client.query("first", { authTimeoutMs: 10_000 });
    await vi.waitFor(() => expect(connections[0]?.connect).toHaveBeenCalledOnce());
    const second = client.query("second", { authTimeoutMs: 100 });
    const rejected = expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    // Lets the second login reach the queue behind the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = 101;
    gate.resolve();
    await rejected;
    await first;
    expect(connections).toHaveLength(1);
    await client.close();
  });
  it("does not accept fulfillment after expiry when the timer callback is delayed", async () => {
    const gate = deferred();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const pending = deadline(gate.promise, 100);
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    now = 101;
    gate.resolve();
    await rejected;
  });
  it("counts synchronous driver fetch setup against the wait deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fake = fakeDriver({ fetchGate: Promise.resolve() });
    const create = fake.driver.createConnection.bind(fake.driver);
    fake.driver.createConnection = (options) => {
      const connection = create(options);
      const fetch = connection.fetchResult.bind(connection);
      connection.fetchResult = (options) => {
        now += 101;
        return fetch(options);
      };
      return connection;
    };
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        authenticator: "OAUTH",
        token: "synthetic",
      }),
    });
    const handle = await client.submit("synthetic");
    await expect(handle.result({ waitTimeoutMs: 100 })).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "succeeded" },
    });
    await client.close();
  });
});
