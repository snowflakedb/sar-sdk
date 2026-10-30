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
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createConnectionOptions } from "../src/connection-options/index.js";
import type { ConnectionManagerOptions, PoolOptions } from "../src/index.js";
import { fakeDriver } from "./fake-driver.js";

afterEach(() => {
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const auth = () =>
  createConnectionOptions({ account: "test", authenticator: "OAUTH", token: "synthetic" });
function setup(
  pool: Partial<Extract<PoolOptions, { mode: "reusable" }>> = {},
  fakeOptions: Parameters<typeof fakeDriver>[0] = {},
) {
  const fake = fakeDriver(fakeOptions);
  const createPool = vi.spyOn(fake.driver, "createPool");
  const manager = createConnectionManager(auth(), {
    driver: fake.driver,
    pool: { mode: "reusable", reset: async () => {}, ...pool },
  });
  return { manager, createPool, ...fake };
}
function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw Error("expected an error");
}

describe("reusable sessions from the driver's pool", () => {
  it("passes driver pool options through unchanged, with the SDK's size and idle timeout", async () => {
    const { manager, createPool, connections } = setup({
      maxConnections: 3,
      idleTimeoutMs: 1234,
      driverPoolOptions: {
        fifo: false,
        evictionRunIntervalMillis: 0,
        futureOption: "kept",
      } as never,
    });
    const first = await manager.withConnection(async (connection) => connection);
    expect(await manager.withConnection(async (connection) => connection)).toBe(first);
    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool.mock.calls[0]?.[1]).toEqual({
      fifo: false,
      evictionRunIntervalMillis: 0,
      futureOption: "kept",
      max: 3,
      min: 0,
      idleTimeoutMillis: 1234,
    });
    expect(connections).toHaveLength(1);
    expect(connections[0]?.config).toMatchObject({
      account: "test",
      token: "synthetic",
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
    });
    await manager.close();
  });
  it.each([
    ["max", "maxConnections"],
    ["min", "on demand"],
    ["acquireTimeoutMillis", "acquireTimeoutMs"],
    ["maxWaitingClients", "maxQueue"],
    ["idleTimeoutMillis", "idleTimeoutMs"],
  ])("rejects driverPoolOptions.%s, which the SDK sets", (key, replacement) => {
    const error = thrown(() =>
      createConnectionManager(undefined, {
        pool: { mode: "reusable", reset: async () => {}, driverPoolOptions: { [key]: 1 } },
      }),
    );
    expect(error).toMatchObject({ code: "INVALID_OPTIONS" });
    expect((error as Error).message).toContain(replacement);
  });
  it.each([
    { mode: "reusable", reset: async () => {}, driverPoolOptions: [] },
    { driverPoolOptions: null },
  ])("rejects invalid driver pool configuration %j", (pool) => {
    expect(
      thrown(() => createConnectionManager(undefined, { pool } as ConnectionManagerOptions)),
    ).toMatchObject({ code: "INVALID_OPTIONS" });
  });
  it("requires createPool from an injected driver", () => {
    const { createConnection } = fakeDriver().driver;
    for (const pool of [undefined, { mode: "reusable" as const, reset: async () => {} }])
      expect(
        thrown(() =>
          createConnectionManager(auth(), { driver: { createConnection } as never, pool }),
        ),
      ).toMatchObject({ code: "INVALID_OPTIONS" });
  });
  it("opens isolated owner sessions and caller views from driver pools too", async () => {
    const fake = fakeDriver();
    const createPool = vi.spyOn(fake.driver, "createPool");
    const manager = createConnectionManager(auth(), {
      driver: fake.driver,
      pool: { driverPoolOptions: { fifo: false } },
    });
    await manager.withConnection(async () => {});
    await manager.asCaller({ token: "synthetic-caller" }).withConnection(async () => {});
    expect(createPool.mock.calls.map(([, options]) => options)).toEqual([
      { fifo: false, max: 10, min: 0, idleTimeoutMillis: 60_000 },
      { fifo: false, max: 10, min: 0, idleTimeoutMillis: 60_000 },
    ]);
    // An isolated owner session logs out on release; a caller session waits for its view.
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(fake.connections[1]?.destroy).not.toHaveBeenCalled();
    await manager.close();
    expect(fake.connections[1]?.destroy).toHaveBeenCalledOnce();
  });
  it("reports a pooled login failure without Snowflake's code, which the driver's pool drops", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {
      connectError: Object.assign(Error("Invalid OAuth access token."), { code: "390303" }),
    };
    const { manager } = setup({}, fakeOptions);
    const error = await manager.withConnection(async () => {}).catch((failure) => failure);
    expect(error).toMatchObject({ code: "AUTH_FAILED", details: { completion: "not-submitted" } });
    expect(error).not.toHaveProperty("details.errorCode");
    expect((await manager.diagnostics()).physicalConnections).toBe(0);
    fakeOptions.connectError = undefined;
    await manager.withConnection(async () => {});
    expect((await manager.diagnostics()).physicalConnections).toBe(1);
    await manager.close();
  });
  it("stops using a pool whose factory throws, keeping the driver's error", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {
      constructError: Object.assign(Error("synthetic invalid options"), { code: "401001" }),
    };
    const { manager, createPool, connections } = setup({}, fakeOptions);
    await expect(manager.withConnection(async () => {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      details: { errorCode: "401001" },
    });
    expect((await manager.diagnostics()).physicalConnections).toBe(0);
    fakeOptions.constructError = undefined;
    await manager.withConnection(async () => {});
    await manager.withConnection(async () => {});
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(connections).toHaveLength(1);
    await manager.close();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it("counts sessions that the driver's evictor logs out", async () => {
    const { manager, connections } = setup({
      driverPoolOptions: { evictionRunIntervalMillis: 5, softIdleTimeoutMillis: 1 },
    });
    await manager.withConnection(async () => {});
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    expect(await manager.diagnostics()).toMatchObject({
      idleConnections: 0,
      physicalConnections: 0,
    });
    await manager.close();
  });
  it("replaces a session that fails the driver's testOnBorrow validation", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {};
    const { manager, connections } = setup(
      { driverPoolOptions: { testOnBorrow: true } },
      fakeOptions,
    );
    const first = await manager.withConnection(async (connection) => connection);
    fakeOptions.invalid = "query-1";
    expect(await manager.withConnection(async (connection) => connection)).not.toBe(first);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(await manager.diagnostics()).toMatchObject({
      idleConnections: 1,
      physicalConnections: 1,
    });
    await manager.close();
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
  });
  it("hands a returned session to a borrower still waiting for its own login", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {};
    const { manager, connections } = setup({ maxConnections: 2 }, fakeOptions);
    const gate = deferred();
    const started = deferred();
    const first = manager.withConnection(async (connection) => {
      started.resolve();
      await gate.promise;
      return connection;
    });
    await started.promise;
    const login = deferred();
    fakeOptions.connectGate = login.promise;
    const second = manager.withConnection(async (connection) => connection);
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    gate.resolve();
    const held = await first;
    expect(await second).toBe(held);
    login.resolve();
    await manager.close();
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
