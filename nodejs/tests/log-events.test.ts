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
import type snowflake from "snowflake-sdk";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions, type ConnectionOptionsProvider } from "../src/auth.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import type { LogEvent, Transaction } from "../src/types.js";
import { failedQueryError, fakeDriver } from "./fake-driver.js";
import { deferred, fakeQueryService } from "./fake-query-service.js";

type Connection = ReturnType<typeof fakeDriver>["connections"][number];
const token = "token-marker-5b1a";
const ms = expect.any(Number);

const factory = () =>
  createConnectionOptions({
    account: "org-account",
    accessUrl: "https://org-account.snowflakecomputing.com",
    authenticator: "OAUTH",
    token,
  });
function setup(fakeOptions: Parameters<typeof fakeDriver>[0] = {}) {
  const events: LogEvent[] = [];
  const fake = fakeDriver(fakeOptions);
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: factory(),
    logger: (event) => events.push(event),
  });
  return { ...fake, client, events };
}
function detachedSetup() {
  const events: LogEvent[] = [];
  const service = fakeQueryService();
  const client = createSarClient({
    driver: service.driver,
    connectionOptions: factory(),
    logger: (event) => events.push(event),
  });
  return { ...service, client, events };
}
const sqlTexts = (connection: Connection | undefined) =>
  (connection?.execute.mock.calls ?? []).map(
    ([options]) => (options as snowflake.StatementOption).sqlText,
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("query log events", () => {
  it("logs each owner login and statement", async () => {
    const { client, events } = setup({ rows: [["1"], ["2"]] });
    expect((await client.query("SELECT 1")).rowCount).toBe(2);
    const stream = await client.stream("SELECT 2");
    expect(events.at(-1)).toStrictEqual({
      event: "query-succeeded",
      queryId: "query-2",
      durationMs: ms,
    });
    for await (const row of stream) expect(row).toBeDefined();
    const handle = await client.submit("SELECT 3");
    await handle.result();
    await handle.result();
    await client.transaction(async (tx) => {
      await tx.query("SELECT 4");
      await tx.query("SELECT 5");
    });
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-succeeded", queryId: "query-1", durationMs: ms, rowCount: 2 },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-succeeded", queryId: "query-2", durationMs: ms },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-succeeded", queryId: "query-3", durationMs: ms, rowCount: 2 },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-succeeded", queryId: "query-4", durationMs: ms, rowCount: 2 },
      { event: "query-succeeded", queryId: "query-4", durationMs: ms, rowCount: 2 },
    ]);
    await client.close();
  });
  it("logs a caller view's login once, not when its later operations reuse the session", async () => {
    const { client, connections, events } = setup();
    const alice = client.asCaller({ token: "alice" });
    await alice.query("SELECT 1");
    for await (const row of await alice.stream("SELECT 2")) expect(row).toBeDefined();
    await (await alice.submit("SELECT 3")).result();
    await alice.transaction(async (tx) => tx.query("SELECT 4"));
    await alice.withConnection(async () => {});
    await client.asCaller({ token: "bob" }).query("SELECT 5");
    expect(connections).toHaveLength(2);
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "caller", durationMs: ms },
      { event: "query-succeeded", queryId: "query-1", durationMs: ms, rowCount: 1 },
      { event: "query-succeeded", queryId: "query-1", durationMs: ms },
      { event: "query-succeeded", queryId: "query-1", durationMs: ms, rowCount: 1 },
      { event: "query-succeeded", queryId: "query-1", durationMs: ms, rowCount: 1 },
      { event: "session-opened", mode: "caller", durationMs: ms },
      { event: "query-succeeded", queryId: "query-2", durationMs: ms, rowCount: 1 },
    ]);
    await client.close();
  });
  it("logs only completed detached results, not their sessions, submission, or status checks", async () => {
    const { client, queries, events } = detachedSetup();
    const reference = await client.submitDetached("SELECT 1");
    expect(await client.pollQuery(reference)).toStrictEqual({
      status: "pending",
      queryId: reference.queryId,
    });
    expect(await client.getQueryStatus(reference)).toBe("RUNNING");
    expect(events).toStrictEqual([]);
    queries.get(reference.queryId)!.status = "SUCCESS";
    expect(await client.pollQuery(reference)).toMatchObject({ result: { rowCount: 1 } });
    const outcome = await client.streamQuery(reference);
    if (outcome.status !== "complete") throw Error("expected a complete result");
    await outcome.stream.close();
    expect(await client.cancelQuery(reference)).toMatchObject({ cancelled: false });
    const caller = client.asCaller({ token: "alice" });
    const callerReference = await caller.submitDetached("SELECT 2");
    queries.get(callerReference.queryId)!.status = "SUCCESS";
    await caller.pollQuery(callerReference);
    expect(events).toStrictEqual([
      { event: "query-succeeded", queryId: reference.queryId, durationMs: ms, rowCount: 1 },
      { event: "query-succeeded", queryId: reference.queryId, durationMs: ms },
      { event: "query-succeeded", queryId: callerReference.queryId, durationMs: ms, rowCount: 1 },
    ]);
    await client.close();
  });
  it("rounds durations to whole milliseconds from the operation's start, including login", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const login = deferred();
    const execution = deferred();
    const { client, connections, events } = setup({
      connectGate: login.promise,
      sqlGates: { "SELECT 1": execution.promise },
    });
    const result = client.query("SELECT 1");
    // A nonzero polling interval would also advance the fake clock.
    await vi.waitUntil(() => connections[0]?.connect.mock.calls.length, { interval: 0 });
    vi.advanceTimersByTime(25.4);
    login.resolve();
    await vi.waitUntil(() => sqlTexts(connections[0]).includes("SELECT 1"), { interval: 0 });
    vi.advanceTimersByTime(10.2);
    execution.resolve();
    await result;
    const handle = await client.submit("SELECT 2");
    vi.advanceTimersByTime(100);
    await handle.result();
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "owner", durationMs: 25 },
      { event: "query-succeeded", queryId: "query-1", durationMs: 36, rowCount: 1 },
      { event: "session-opened", mode: "owner", durationMs: 0 },
      { event: "query-succeeded", queryId: "query-2", durationMs: 100, rowCount: 1 },
    ]);
    await client.close();
  });
  it("prints one line per query from the logger passed to createSarClient", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: factory(),
      logger: (event) => console.log("[snowflake]", JSON.stringify(event)),
    });
    await client.query("SELECT 1");
    await client.close();
    expect(fake.connections[0]?.config.token).toBe(token);
    expect(print.mock.calls).toEqual([
      [
        "[snowflake]",
        expect.stringMatching(/^\{"event":"session-opened","mode":"owner","durationMs":\d+\}$/),
      ],
      [
        "[snowflake]",
        expect.stringMatching(
          /^\{"event":"query-succeeded","queryId":"query-1","durationMs":\d+,"rowCount":1\}$/,
        ),
      ],
    ]);
  });
  it("logs through standalone components that share the manager", async () => {
    const events: LogEvent[] = [];
    const fake = fakeDriver();
    const manager = createConnectionManager(factory(), {
      driver: fake.driver,
      logger: (event) => events.push(event),
    });
    const queries = createQueryClient(manager);
    const scoped = createQueryClient(manager.asCaller({ token: "alice" }));
    await manager.connect();
    await manager.withConnection(async () => {});
    await queries.query("SELECT 1");
    await scoped.query("SELECT 2");
    await queries.asCaller({ token: "bob" }).query("SELECT 3");
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-succeeded", queryId: "query-3", durationMs: ms, rowCount: 1 },
      { event: "session-opened", mode: "caller", durationMs: ms },
      { event: "query-succeeded", queryId: "query-4", durationMs: ms, rowCount: 1 },
      { event: "session-opened", mode: "caller", durationMs: ms },
      { event: "query-succeeded", queryId: "query-5", durationMs: ms, rowCount: 1 },
    ]);
    await Promise.all([queries.close(), scoped.close()]);
    await manager.close();
  });
});

describe("query failure events", () => {
  it("carry Snowflake's error code for rejected owner and caller statements", async () => {
    const { client, events } = setup({
      status: "FAILED_WITH_ERROR",
      queryError: failedQueryError("002003", "synthetic message", "SELECT 1"),
    });
    const rejected = { code: "QUERY_FAILED", details: { errorCode: "002003" } };
    await expect(client.query("SELECT 1")).rejects.toMatchObject(rejected);
    await expect(client.stream("SELECT 1")).rejects.toMatchObject(rejected);
    await expect((await client.submit("SELECT 1")).result()).rejects.toMatchObject(rejected);
    await client.transaction(async (tx) => {
      await expect(tx.query("SELECT 1")).rejects.toMatchObject(rejected);
    });
    await expect(client.asCaller({ token: "alice" }).query("SELECT 1")).rejects.toMatchObject(
      rejected,
    );
    const failed = (queryId: string) => ({
      event: "query-failed",
      queryId,
      code: "QUERY_FAILED",
      errorCode: "002003",
      durationMs: ms,
    });
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "owner", durationMs: ms },
      failed("query-1"),
      { event: "session-opened", mode: "owner", durationMs: ms },
      failed("query-2"),
      { event: "session-opened", mode: "owner", durationMs: ms },
      failed("query-3"),
      { event: "session-opened", mode: "owner", durationMs: ms },
      failed("query-4"),
      { event: "session-opened", mode: "caller", durationMs: ms },
      failed("query-5"),
    ]);
    await client.close();
  });
  it("carry a failed login's code without a session or query ID", async () => {
    const { client, events } = setup({
      connectError: Object.assign(new Error("synthetic login failure"), { code: "390303" }),
    });
    const rejected = { code: "AUTH_FAILED", details: { errorCode: "390303" } };
    await expect(client.query("SELECT 1")).rejects.toMatchObject(rejected);
    await expect(client.submit("SELECT 1")).rejects.toMatchObject(rejected);
    await expect(client.asCaller({ token: "alice" }).stream("SELECT 1")).rejects.toMatchObject(
      rejected,
    );
    await expect(client.connect()).rejects.toMatchObject(rejected);
    const failed = {
      event: "query-failed",
      code: "AUTH_FAILED",
      errorCode: "390303",
      durationMs: ms,
    };
    expect(events).toStrictEqual([failed, failed, failed]);
    await client.close();
  });
  it("carry the SDK code alone for failures Snowflake didn't report", async () => {
    const { client, events } = setup({ rows: [["1"], ["2"]] });
    await expect(client.query("SELECT 1", { maxRows: 1 })).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
    await expect(client.query(" ")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    let ended: Transaction | undefined;
    await client.transaction(async (tx) => {
      ended = tx;
    });
    await expect(ended!.query("SELECT 2")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(events).toStrictEqual([
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-failed", queryId: "query-1", code: "RESULT_LIMIT_EXCEEDED", durationMs: ms },
      { event: "query-failed", code: "INVALID_OPTIONS", durationMs: ms },
      { event: "session-opened", mode: "owner", durationMs: ms },
      { event: "query-failed", code: "INVALID_OPTIONS", durationMs: ms },
    ]);
    await client.close();
  });
  it("carry a failed detached query's code, and never an unvalidated reference's query ID", async () => {
    const { client, queries, events } = detachedSetup();
    const reference = await client.submitDetached("SELECT 1");
    Object.assign(queries.get(reference.queryId)!, {
      status: "FAILED_WITH_ERROR",
      error: failedQueryError("000630", "synthetic message", "SELECT 1"),
    });
    const rejected = { code: "QUERY_FAILED", details: { errorCode: "000630" } };
    await expect(client.pollQuery(reference)).rejects.toMatchObject(rejected);
    await expect(client.streamQuery(reference)).rejects.toMatchObject(rejected);
    await expect(
      client.pollQuery({ ...reference, queryId: "reference-marker-0d4e" }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    const failed = {
      event: "query-failed",
      queryId: reference.queryId,
      code: "QUERY_FAILED",
      errorCode: "000630",
      durationMs: ms,
    };
    expect(events).toStrictEqual([
      failed,
      failed,
      { event: "query-failed", code: "INVALID_OPTIONS", durationMs: ms },
    ]);
    await client.close();
  });
});

describe("logger boundaries", () => {
  it("ignores a logger that throws or rejects", async () => {
    let calls = 0;
    // Not vi.fn(), which handles the rejections it records.
    for (const logger of [
      () => {
        calls++;
        throw Error("synthetic logger failure");
      },
      async () => {
        calls++;
        throw Error("synthetic logger rejection");
      },
    ]) {
      const fake = fakeDriver({
        sqlErrors: { "SELECT 2": Object.assign(new Error("synthetic"), { code: "002003" }) },
      });
      const client = createSarClient({
        driver: fake.driver,
        connectionOptions: factory(),
        logger,
      });
      expect((await client.query("SELECT 1")).rows).toEqual([{ VALUE: "9007199254740993" }]);
      await expect(client.query("SELECT 2")).rejects.toMatchObject({
        code: "QUERY_FAILED",
        details: { errorCode: "002003" },
      });
      const handle = await client.asCaller({ token: "alice" }).submit("SELECT 3");
      expect((await handle.result()).rowCount).toBe(1);
      await client.close();
    }
    expect(calls).toBe(12);
  });
  it("logs to the client's logger for custom options providers, and nothing without one", async () => {
    const auth = factory();
    const delegating: ConnectionOptionsProvider = {
      getOwnerOptions: () => auth.getOwnerOptions(),
      getCallerOptions: (callerToken) => auth.getCallerOptions(callerToken),
    };
    for (const provider of [delegating, { ...auth }]) {
      const events: LogEvent[] = [];
      const fake = fakeDriver();
      const client = createSarClient({
        driver: fake.driver,
        connectionOptions: provider,
        logger: (event) => events.push(event),
      });
      // A manager sharing the provider but given no logger logs nowhere.
      const manager = createConnectionManager(provider, { driver: fake.driver });
      const queries = createQueryClient(manager);
      await client.query("SELECT 1");
      await client.asCaller({ token: "alice" }).query("SELECT 2");
      await expect(client.query(" ")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
      await queries.query("SELECT 3");
      await manager.connect();
      expect(fake.connections).toHaveLength(4);
      expect(events).toStrictEqual([
        { event: "session-opened", mode: "owner", durationMs: ms },
        { event: "query-succeeded", queryId: "query-1", durationMs: ms, rowCount: 1 },
        { event: "session-opened", mode: "caller", durationMs: ms },
        { event: "query-succeeded", queryId: "query-2", durationMs: ms, rowCount: 1 },
        { event: "query-failed", code: "INVALID_OPTIONS", durationMs: ms },
      ]);
      await Promise.all([client.close(), queries.close()]);
      await manager.close();
    }
  });
  it("never logs SQL text, binds, rows, tokens, or error messages", async () => {
    const markers = {
      sql: "sql-marker-3f9c",
      bind: "bind-marker-81d2",
      row: "row-marker-c47e",
      caller: "caller-marker-e93d",
      message: "message-marker-2a6f",
    };
    const sql = `SELECT '${markers.sql}' AS VALUE WHERE ID = ?`;
    const rejected = `${sql} AND FAILS`;
    const binds = [markers.bind];
    const failure = Object.assign(new Error(`${markers.message} near '${markers.sql}'`), {
      code: "002003",
      sqlState: "42S02",
    });
    const sync = setup({ rows: [[markers.row]], sqlErrors: { [rejected]: failure } });
    for (const scope of [sync.client, sync.client.asCaller({ token: markers.caller })]) {
      await scope.query(sql, { binds });
      for await (const row of await scope.stream(sql, { binds }))
        expect(row).toEqual({ VALUE: markers.row });
      await (await scope.submit(sql, { binds })).result();
      await scope.transaction(async (tx) => {
        await tx.query(sql, { binds });
        await expect(tx.query(rejected, { binds })).rejects.toMatchObject({ code: "QUERY_FAILED" });
      });
      await expect(scope.query(rejected, { binds })).rejects.toMatchObject({
        code: "QUERY_FAILED",
      });
    }
    const login = setup({
      connectError: Object.assign(new Error(`${markers.message} for ${token}`), { code: "390303" }),
    });
    await expect(login.client.query(sql, { binds })).rejects.toMatchObject({ code: "AUTH_FAILED" });
    const detached = detachedSetup();
    detached.settings.rows = [[markers.row]];
    detached.settings.status = "SUCCESS";
    const reference = await detached.client.submitDetached(sql, { binds });
    await detached.client.pollQuery(reference);
    const outcome = await detached.client.streamQuery(reference);
    if (outcome.status !== "complete") throw Error("expected a complete result");
    for await (const row of outcome.stream) expect(row).toEqual({ VALUE: markers.row });
    Object.assign(detached.queries.get(reference.queryId)!, {
      status: "FAILED_WITH_ERROR",
      error: failedQueryError("002003", `${markers.message} near '${markers.sql}'`, sql),
    });
    await expect(detached.client.pollQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
    });

    const events = [...sync.events, ...login.events, ...detached.events];
    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(["session-opened", "query-succeeded", "query-failed"]),
    );
    expect(events.filter((event) => event.event === "query-failed")).toHaveLength(6);
    const fields = ["event", "queryId", "code", "errorCode", "durationMs", "rowCount", "mode"];
    for (const event of events) {
      expect(Object.keys(event).filter((key) => !fields.includes(key))).toEqual([]);
      expect(Number.isInteger(event.durationMs)).toBe(true);
    }
    const serialized = JSON.stringify(events);
    for (const marker of [...Object.values(markers), token])
      expect(serialized).not.toContain(marker);
    await Promise.all([sync.client.close(), login.client.close(), detached.client.close()]);
  });
});
