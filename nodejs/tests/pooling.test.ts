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

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import { createConnectionOptions, fromTokenFile } from "../src/auth.js";
import { SessionStore } from "../src/session-store.js";
import type { ConnectionManagerOptions, PoolOptions } from "../src/types.js";
import { fakeDriver } from "./fake-driver.js";

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
  pool: Partial<Extract<PoolOptions, { mode: "reusable" }>> = {},
  fakeOptions: Parameters<typeof fakeDriver>[0] = {},
) {
  let token = "synthetic-first";
  const acquired = vi.fn(async () => ({ type: "oauth" as const, token }));
  const reset = vi.fn(async () => {});
  const fake = fakeDriver(fakeOptions);
  const manager = createConnectionManager(
    createConnectionOptions(
      [
        {
          id: "test",
          async resolve() {
            return { target: { account: "test" }, platform: "spcs", acquire: acquired };
          },
        },
      ],
      { environment: "deployed", platform: "spcs" },
    ),
    {
      driver: fake.driver,
      pool: { mode: "reusable", reset, ...pool },
    },
  );
  return {
    manager,
    reset,
    acquired,
    ...fake,
    rotate() {
      token = "synthetic-next";
    },
  };
}

describe("bounded session reuse", () => {
  it("close reports an already timed-out physical destruction", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { manager, connections } = setup({}, { destroyGate: gate.promise });
    const work = manager.withConnection(async () => {
      throw Error("synthetic application");
    });
    const rejected = expect(work).rejects.toThrow("synthetic application");
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    await expect(manager.close()).rejects.toMatchObject({ code: "TIMEOUT" });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect((await manager.diagnostics()).physicalConnections).toBe(0);
  });
  it("retains idle sessions from other scopes while spare capacity exists", async () => {
    const { manager, connections } = setup({ maxConnections: 2 });
    const owner = await manager.withConnection(async (connection) => connection);
    await manager.asCaller({ token: "synthetic-caller" }).withConnection(async () => {});
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    expect(await manager.withConnection(async (connection) => connection)).toBe(owner);
    expect((await manager.diagnostics()).physicalConnections).toBe(2);
    await manager.close();
  });
  it("checks idle expiry synchronously even if its timer has not run", async () => {
    const { manager, connections } = setup({ idleTimeoutMs: 100 });
    await manager.withConnection(async () => {});
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now + 101);
    await manager.withConnection(async () => {});
    expect(connections).toHaveLength(2);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    clock.mockRestore();
    await manager.close();
  });
  it("preserves reset receiver while snapshotting its method", async () => {
    const fake = fakeDriver();
    const pool = {
      mode: "reusable" as const,
      maxConnections: 1,
      async reset() {
        expect(this).toBe(pool);
      },
    };
    const manager = createConnectionManager(
      createConnectionOptions([
        {
          id: "test",
          async resolve() {
            return {
              target: { account: "test" },
              async acquire() {
                return { type: "oauth", token: "synthetic" };
              },
            };
          },
        },
      ]),
      { driver: fake.driver, pool },
    );
    pool.reset = async () => {
      throw Error("replaced reset");
    };
    await manager.withConnection(async () => {});
    await manager.close();
  });
  it("discards reset work when shutdown forces an abort", async () => {
    const entered = deferred();
    const gate = deferred();
    const { manager, connections } = setup({
      reset: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const work = manager.withConnection(async () => {});
    const rejected = expect(work).rejects.toMatchObject({ code: "ABORTED" });
    await entered.promise;
    await expect(manager.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    gate.resolve();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await manager.diagnostics()).idleConnections).toBe(0);
  });
  it("shutdown reports idle destruction failure safely", async () => {
    const { manager } = setup({}, { destroyError: Error("synthetic-private-error") });
    await manager.withConnection(async () => {});
    const error = await manager.close().catch((error) => error);
    expect(error).toMatchObject({ code: "QUERY_FAILED" });
    expect(JSON.stringify(error)).not.toContain("synthetic-private-error");
  });
  it("reuses only after reset; rotation changes new logins, not existing sessions", async () => {
    const { manager, connections, reset, acquired, rotate } = setup({ maxConnections: 2 });
    const first = await manager.withConnection(async (connection) => connection);
    rotate();
    expect(await manager.withConnection(async (connection) => connection)).toBe(first);
    expect(acquired).toHaveBeenCalledOnce();
    const gate = deferred();
    const started = deferred();
    const borrowed = manager.withConnection(async (connection) => {
      expect(connection).toBe(first);
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    await manager.withConnection(async () => {});
    expect(connections[1]?.config.token).toBe("synthetic-next");
    gate.resolve();
    await borrowed;
    expect(reset).toHaveBeenCalledTimes(4);
    expect(await manager.diagnostics()).toMatchObject({
      activeConnections: 0,
      idleConnections: 2,
      physicalConnections: 2,
      sessionMode: "reusable",
    });
    await manager.close();
    expect(connections.every((connection) => connection.destroy.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("reopens token files for new sessions without draining retained sessions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sar-rotation-"));
    const filename = path.join(directory, "token");
    await writeFile(filename, "synthetic-old");
    const fake = fakeDriver();
    const manager = createConnectionManager(
      createConnectionOptions([
        fromTokenFile({ id: "test", path: filename, type: "oauth", target: { account: "test" } }),
      ]),
      {
        driver: fake.driver,
        pool: { mode: "reusable", reset: async () => {}, maxConnections: 2 },
      },
    );
    try {
      const first = await manager.withConnection(async (connection) => connection);
      await writeFile(filename, "synthetic-new");
      expect(await manager.withConnection(async (connection) => connection)).toBe(first);
      const gate = deferred();
      const started = deferred();
      const work = manager.withConnection(async () => {
        started.resolve();
        await gate.promise;
      });
      await started.promise;
      await manager.withConnection(async () => {});
      expect(fake.connections[1]?.config.token).toBe("synthetic-new");
      gate.resolve();
      await work;
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("partitions caller views even with identical tokens and evicts idle scopes for capacity", async () => {
    const { manager, connections } = setup({ maxConnections: 1 });
    const owner = await manager.withConnection(async (connection) => connection);
    const caller = manager.asCaller({ token: "synthetic-caller" });
    const first = await caller.withConnection(async (connection) => connection);
    expect(first).not.toBe(owner);
    expect(await caller.withConnection(async (connection) => connection)).toBe(first);
    const other = manager.asCaller({ token: "synthetic-caller" });
    expect(await other.withConnection(async (connection) => connection)).not.toBe(first);
    expect(connections).toHaveLength(3);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(connections[1]?.destroy).not.toHaveBeenCalled();
    expect(await manager.diagnostics()).toMatchObject({
      physicalConnections: 1,
      idleConnections: 1,
    });
    await manager.close();
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
  });
  it("preserves the application error and discards the session", async () => {
    const { manager, reset, connections } = setup({}, { destroyError: Error("synthetic cleanup") });
    const primary = Error("synthetic application");
    await expect(
      manager.withConnection(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(reset).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("discards and reports reset failure without reusing uncertain state", async () => {
    const { manager, connections } = setup({
      reset: async () => {
        throw Error("synthetic reset");
      },
    });
    await expect(manager.withConnection(async () => 1)).rejects.toMatchObject({
      code: "QUERY_FAILED",
    });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.connect();
    expect(connections).toHaveLength(2);
    await manager.close();
  });
  it("keeps a resetting resource exclusive", async () => {
    const resetGate = deferred();
    const entered = deferred();
    const { manager, connections } = setup({
      maxConnections: 1,
      reset: async () => {
        entered.resolve();
        await resetGate.promise;
      },
    });
    const first = manager.withConnection(async () => 1);
    await entered.promise;
    const callback = vi.fn(async () => 2);
    const second = manager.withConnection(callback);
    await vi.waitFor(async () => expect((await manager.diagnostics()).queuedOperations).toBe(1));
    expect(callback).not.toHaveBeenCalled();
    resetGate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(connections).toHaveLength(1);
    await manager.close();
  });
  it("maxQueue zero refuses work without creating another physical session", async () => {
    const gate = deferred();
    const started = deferred();
    const { manager, connections } = setup({ maxConnections: 1, maxQueue: 0 });
    const first = manager.withConnection(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    await expect(manager.withConnection(async () => {})).rejects.toMatchObject({
      code: "QUEUE_FULL",
    });
    expect(connections).toHaveLength(1);
    gate.resolve();
    await first;
    await manager.close();
  });
  it("shutdown during reset never makes the resource idle again", async () => {
    const gate = deferred();
    const entered = deferred();
    const { manager, connections } = setup({
      reset: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const first = manager.withConnection(async () => {});
    await entered.promise;
    const closing = manager.close();
    gate.resolve();
    await first;
    await closing;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(await manager.diagnostics()).toMatchObject({
      physicalConnections: 0,
      idleConnections: 0,
    });
  });
  it("reset deadline discards a late reset rather than returning it to the pool", async () => {
    const gate = deferred();
    const { manager, connections } = setup({ reset: () => gate.promise, resetTimeoutMs: 5 });
    await expect(manager.withConnection(async () => {})).rejects.toMatchObject({ code: "TIMEOUT" });
    gate.resolve();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("rejects synchronous reset completion", async () => {
    const { manager } = setup({ reset: (() => undefined) as never });
    await expect(manager.withConnection(async () => {})).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await manager.close();
  });
  it.each(["idleTimeoutMs", "maxLifetimeMs"] as const)(
    "expires idle resources using %s",
    async (setting) => {
      const { manager, connections } = setup({ [setting]: 10 });
      await manager.withConnection(async () => {});
      await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
      expect((await manager.diagnostics()).physicalConnections).toBe(0);
      await manager.close();
    },
  );
  it("does not retire a borrowed session on lifetime expiry until release", async () => {
    const gate = deferred();
    const started = deferred();
    const { manager, connections } = setup({ maxLifetimeMs: 10 });
    const first = manager.withConnection(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("holds physical capacity while timed-out destruction is still pending", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const fake = fakeDriver({ destroyGate: gate.promise });
    const store = new SessionStore({ mode: "reusable", reset: async () => {}, maxConnections: 1 });
    const scope = {};
    const first = await store.checkout(scope, undefined, 1000, new AbortController().signal);
    const resource = store.attach(
      fake.driver.createConnection({ account: "test" }),
      scope,
      undefined,
      first.releaseSlot!,
    );
    const discard = store.discard(resource);
    const rejected = expect(discard).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(store.slots.active).toBe(1);
    const next = store.checkout({}, undefined, 10, new AbortController().signal);
    const timedOut = expect(next).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(11);
    await timedOut;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.slots.active).toBe(0);
    await store.closeIdle();
  });
  it.each([
    { mode: "reusable" },
    { mode: "wrong" },
    { reset: async () => {} },
    { idleTimeoutMs: 1 },
    { mode: "reusable", reset: async () => {}, maxLifetimeMs: 0 },
  ])("rejects invalid reuse configuration %j", (pool) => {
    expect(() =>
      createConnectionManager(undefined, { pool } as ConnectionManagerOptions),
    ).toThrow();
  });
});

describe("query lease reuse", () => {
  it("reuses fully consumed results but partitions warehouse overrides", async () => {
    const { manager, connections, reset } = setup({ maxConnections: 1 });
    const queries = createQueryClient(manager);
    await queries.query("synthetic", { warehouse: "WH_ONE" });
    await queries.query("synthetic", { warehouse: "WH_ONE" });
    expect(connections).toHaveLength(1);
    expect(reset).toHaveBeenCalledTimes(2);
    await queries.query("synthetic", { warehouse: "WH_TWO" });
    expect(connections).toHaveLength(2);
    expect(connections[1]?.config.warehouse).toBe("WH_TWO");
    await queries.close();
    await manager.close();
  });
  it.each(["close", "break", "abort", "limit", "decoder", "cancel"])(
    "discards incomplete or failed work: %s",
    async (action) => {
      const { manager, connections, reset } = setup(
        { maxConnections: 1 },
        { rows: [["1"], ["2"]] },
      );
      const queries = createQueryClient(manager);
      if (action === "limit")
        await expect(queries.query("synthetic", { maxRows: 1 })).rejects.toMatchObject({
          code: "RESULT_LIMIT_EXCEEDED",
        });
      else if (action === "decoder")
        await expect(
          queries.query("synthetic", {
            decodeRow() {
              throw Error("synthetic");
            },
          }),
        ).rejects.toThrow();
      else if (action === "cancel") {
        const handle = await queries.submit("synthetic");
        await handle.cancel();
      } else {
        const controller = new AbortController();
        const stream = await queries.stream("synthetic", { signal: controller.signal });
        if (action === "close") await stream.close();
        if (action === "break") {
          for await (const row of stream) {
            expect(row).toBeDefined();
            break;
          }
        }
        if (action === "abort") {
          controller.abort();
          await stream.close();
        }
      }
      expect(reset).not.toHaveBeenCalled();
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
      await queries.close();
      await manager.close();
    },
  );
  it("holds stream and submitted handle leases exclusively", async () => {
    const { manager, connections } = setup({ maxConnections: 1 });
    const queries = createQueryClient(manager);
    const stream = await queries.stream("synthetic");
    const callback = vi.fn(async () => {});
    const raw = manager.withConnection(callback);
    await vi.waitFor(async () => expect((await manager.diagnostics()).queuedOperations).toBe(1));
    expect(callback).not.toHaveBeenCalled();
    for await (const row of stream) expect(row).toBeDefined();
    await raw;
    expect(connections).toHaveLength(1);
    const handle = await queries.submit("synthetic");
    const raw2 = manager.withConnection(callback);
    await vi.waitFor(async () => expect((await manager.diagnostics()).queuedOperations).toBe(1));
    await handle.result();
    await raw2;
    expect(connections).toHaveLength(1);
    await queries.close();
    await manager.close();
  });
});
