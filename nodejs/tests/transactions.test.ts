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
import { createSarClient, type SarError } from "../src/index.js";
import {
  createConnectionOptions,
  fromCredentials,
  type ConnectionOptionsFactoryOptions,
} from "../src/auth.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import { temporalSessionSql } from "../src/results.js";
import type {
  SarClientOptions,
  Transaction,
  TransactionOptions,
  TransactionQueryOptions,
} from "../src/types.js";
import { failedQueryError, fakeDriver } from "./fake-driver.js";

type FakeOptions = Parameters<typeof fakeDriver>[0];
type Connection = ReturnType<typeof fakeDriver>["connections"][number];

const target = { account: "org-account", accessUrl: "https://org-account.snowflakecomputing.com" };
const credentials = () =>
  fromCredentials({ target, credential: { type: "oauth", token: "test-token" } });
function setup(
  fakeOptions: FakeOptions = {},
  overrides: Pick<SarClientOptions, "pool" | "timeouts" | "results"> &
    Pick<ConnectionOptionsFactoryOptions, "environment" | "platform"> = {},
) {
  const fake = fakeDriver(fakeOptions);
  const { environment, platform, ...execution } = overrides;
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: createConnectionOptions([credentials()], { environment, platform }),
    ...execution,
  });
  return { client, ...fake };
}
function reusable(fakeOptions: FakeOptions = {}) {
  const fake = fakeDriver(fakeOptions);
  const reset = vi.fn(async () => {});
  const manager = createConnectionManager(
    createConnectionOptions([credentials()], { environment: "local" }),
    { driver: fake.driver, pool: { mode: "reusable", reset, maxConnections: 1 } },
  );
  return { ...fake, reset, manager, queries: createQueryClient(manager) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const executions = (connection: Connection | undefined) =>
  (connection?.execute.mock.calls ?? []).map(
    ([execution]) => execution as snowflake.StatementOption,
  );
const sqlTexts = (connection: Connection | undefined) =>
  executions(connection).map((execution) => execution.sqlText);

afterEach(() => vi.useRealTimers());

describe("transaction lifecycle", () => {
  it("runs BEGIN, the statements, and COMMIT in order on one session", async () => {
    const { client, connections } = setup();
    const rows = await client.transaction(async (tx) => {
      await tx.query("INSERT INTO ORDERS VALUES (?)", { binds: [1] });
      return (await tx.query("SELECT ?", { binds: [2] })).rows;
    });
    expect(rows).toEqual([{ VALUE: "9007199254740993" }]);
    expect(connections).toHaveLength(1);
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO ORDERS VALUES (?)",
      "SELECT ?",
      "COMMIT",
    ]);
    const [format, begin, insert, select, commit] = executions(connections[0]);
    expect(insert).toMatchObject({
      binds: [1],
      asyncExec: true,
      parameters: { MULTI_STATEMENT_COUNT: 1 },
    });
    expect(select).toMatchObject({ binds: [2], asyncExec: true });
    for (const control of [format, begin, commit]) {
      expect(control?.asyncExec).toBeUndefined();
      expect(control?.binds).toBeUndefined();
    }
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("returns results, conversions, and limit errors as query() does", async () => {
    const { client, connections } = setup({
      names: ["ID", "DATA"],
      rows: [
        ["1", "a"],
        ["2", "b"],
      ],
    });
    const expected = await client.query("SELECT ID, DATA FROM T");
    await client.transaction(async (tx) => {
      expect(await tx.query("SELECT ID, DATA FROM T")).toEqual({ ...expected, queryId: "query-2" });
      expect((await tx.query("SELECT ID, DATA FROM T", { rowMode: "array" })).rows).toEqual([
        ["1", "a"],
        ["2", "b"],
      ]);
      const decoded = await tx.query<string>("SELECT ID, DATA FROM T", {
        decodeRow: (row) => (row as { ID: string }).ID,
      });
      expect(decoded.rows).toEqual(["1", "2"]);
      await expect(tx.query("SELECT ID, DATA FROM T", { maxRows: 1 })).rejects.toMatchObject({
        code: "RESULT_LIMIT_EXCEEDED",
        details: { queryId: "query-2", completion: "succeeded" },
      });
    });
    expect(sqlTexts(connections[1]).at(-1)).toBe("COMMIT");
    expect(connections[1]?.cancel).not.toHaveBeenCalled();
    await client.close();
  });
  it("rolls back and rethrows the callback's own error", async () => {
    const { client, connections } = setup();
    const failure = new Error("synthetic application failure");
    await expect(
      client.transaction(async (tx) => {
        await tx.query("INSERT INTO ORDERS VALUES (1)");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO ORDERS VALUES (1)",
      "ROLLBACK",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("rolls back after a failed statement and keeps its error details", async () => {
    const { client, connections } = setup({
      status: "FAILED_WITH_ERROR",
      queryError: failedQueryError(
        "100072",
        "NULL result in a non-nullable column",
        "INSERT INTO T VALUES ('123-45-6789')",
      ),
    });
    const error = await client
      .transaction(async (tx) => {
        await tx.query("INSERT INTO T VALUES (?)", { binds: ["123-45-6789"] });
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed (error 100072)",
      details: { queryId: "query-1", completion: "failed", errorCode: "100072" },
    });
    expect(JSON.stringify(error)).not.toContain("123-45-6789");
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (?)",
      "ROLLBACK",
    ]);
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("commits when the callback handles a failed statement", async () => {
    const { client, connections } = setup({ statuses: ["FAILED_WITH_ERROR", "SUCCESS"] });
    const [first, second] = await client.transaction(async (tx) =>
      Promise.allSettled([
        tx.query("INSERT INTO T VALUES (1)"),
        tx.query("INSERT INTO T VALUES (2)"),
      ]),
    );
    expect(first).toMatchObject({
      status: "rejected",
      reason: { code: "QUERY_FAILED", details: { completion: "failed" } },
    });
    expect(second).toMatchObject({ status: "fulfilled", value: { rowCount: 1 } });
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "INSERT INTO T VALUES (2)",
      "COMMIT",
    ]);
    await client.close();
  });
  it("reports an unknown outcome when COMMIT fails", async () => {
    const { client, connections } = setup({
      sqlErrors: {
        COMMIT: Object.assign(Error("synthetic commit failure"), {
          code: "000604",
          sqlState: "57014",
        }),
      },
    });
    const error = await client
      .transaction(async (tx) => {
        await tx.query("INSERT INTO T VALUES (1)");
        return "committed";
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Transaction commit failed; its outcome is unknown",
      details: { completion: "unknown", errorCode: "000604", sqlState: "57014" },
    });
    expect((error as SarError).details.queryId).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("synthetic commit failure");
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "COMMIT",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("treats an abort during COMMIT as an unknown outcome", async () => {
    const commit = deferred();
    const controller = new AbortController();
    const { client, connections } = setup({ sqlGates: { COMMIT: commit.promise } });
    const pending = client.transaction(
      async (tx) => {
        await tx.query("INSERT INTO T VALUES (1)");
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(sqlTexts(connections[0])).toContain("COMMIT"));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "unknown" },
    });
    commit.resolve();
    expect(sqlTexts(connections[0])).not.toContain("ROLLBACK");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("resolves after COMMIT even when the session logout fails", async () => {
    const { client, connections } = setup({ destroyError: Error("synthetic logout failure") });
    const value = await client.transaction(async (tx) => {
      await tx.query("INSERT INTO T VALUES (1)");
      return "committed";
    });
    expect(value).toBe("committed");
    expect(sqlTexts(connections[0]).at(-1)).toBe("COMMIT");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(await client.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 0,
    });
    await client.close();
  });
  it("resolves after COMMIT and discards the session when its reset fails", async () => {
    const { connections, reset, manager, queries } = reusable();
    reset.mockRejectedValueOnce(Error("synthetic reset failure"));
    const value = await queries.transaction(
      async (tx) => (await tx.query("INSERT INTO T VALUES (1)")).rowCount,
    );
    expect(value).toBe(1);
    expect(reset).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0]).at(-1)).toBe("COMMIT");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(await manager.diagnostics()).toMatchObject({
      activeConnections: 0,
      idleConnections: 0,
      physicalConnections: 0,
    });
    await queries.close();
    await manager.close();
  });
  it.each([
    ["BEGIN", { sqlErrors: { BEGIN: Error("synthetic begin failure") } }, ["BEGIN"]],
    ["format setup", { initializationError: Error("synthetic format failure") }, []],
  ] as const)("does not run the callback after a failed %s", async (_, fakeOptions, after) => {
    const { client, connections } = setup(fakeOptions);
    const callback = vi.fn(async () => {});
    const error = await client.transaction(callback).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Transaction start failed; user SQL was not submitted",
      details: { completion: "not-submitted" },
    });
    expect(JSON.stringify(error)).not.toContain("synthetic");
    expect(callback).not.toHaveBeenCalled();
    expect(sqlTexts(connections[0])).toEqual([temporalSessionSql, ...after]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("rejects statements once the transaction has ended", async () => {
    const { client, connections } = setup();
    let committed!: Transaction;
    let rolledBack!: Transaction;
    await client.transaction(async (tx) => {
      committed = tx;
    });
    await expect(
      client.transaction(async (tx) => {
        rolledBack = tx;
        throw Error("synthetic application failure");
      }),
    ).rejects.toThrow("synthetic application failure");
    for (const tx of [committed, rolledBack])
      await expect(tx.query("SELECT 1")).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
        message: "Transaction has ended",
      });
    expect(Object.isFrozen(committed)).toBe(true);
    expect(connections.map(sqlTexts)).toEqual([
      [temporalSessionSql, "BEGIN", "COMMIT"],
      [temporalSessionSql, "BEGIN", "ROLLBACK"],
    ]);
    await client.close();
  });
  it("requires a callback that returns a Promise", async () => {
    const { client, connections } = setup();
    await expect(client.transaction(undefined as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(connections).toHaveLength(0);
    await expect(client.transaction((() => 1) as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "Transaction callbacks must return a Promise and await every statement",
    });
    const failure = Error("synthetic synchronous failure");
    await expect(
      client.transaction(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    for (const connection of connections) {
      expect(sqlTexts(connection)).toEqual([temporalSessionSql, "BEGIN", "ROLLBACK"]);
      expect(connection.destroy).toHaveBeenCalledOnce();
    }
    expect(connections).toHaveLength(2);
    await client.close();
  });
  it("rolls back when the callback returns before its statements settle", async () => {
    const { client, connections } = setup({ status: "RUNNING" });
    let running!: Promise<unknown>;
    let queued!: Promise<unknown>;
    await expect(
      client.transaction(async (tx) => {
        running = tx.query("INSERT INTO T VALUES (1)").catch((error: unknown) => error);
        queued = tx.query("INSERT INTO T VALUES (2)").catch((error: unknown) => error);
      }),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "Transaction callbacks must await every statement",
    });
    expect(await running).toMatchObject({ code: "ABORTED" });
    expect(await queued).toMatchObject({
      code: "INVALID_OPTIONS",
      message: "Transaction has ended",
    });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "ROLLBACK",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("runs concurrent statements one at a time in call order", async () => {
    const fetch = deferred();
    const { client, connections } = setup({ fetchGate: fetch.promise });
    const statements = () => sqlTexts(connections[0]).slice(2);
    const results = await client.transaction(async (tx) => {
      const pending = [tx.query("SELECT 1"), tx.query("SELECT 2"), tx.query("SELECT 3")];
      await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalledOnce());
      expect(statements()).toEqual(["SELECT 1"]);
      fetch.resolve();
      return Promise.all(pending);
    });
    expect(results.map((result) => result.rowCount)).toEqual([1, 1, 1]);
    expect(statements()).toEqual(["SELECT 1", "SELECT 2", "SELECT 3", "COMMIT"]);
    await client.close();
  });
  it("holds one session and admission slot for the whole callback", async () => {
    const { client, connections } = setup({}, { pool: { maxConnections: 1, maxQueue: 1 } });
    const gate = deferred();
    const started = deferred();
    const work = client.transaction(async (tx) => {
      await tx.query("SELECT 1");
      started.resolve();
      await gate.promise;
      return tx.query("SELECT 2");
    });
    await started.promise;
    const other = client.query("SELECT 3");
    await vi.waitFor(async () => expect((await client.diagnostics()).queuedOperations).toBe(1));
    expect(connections).toHaveLength(1);
    gate.resolve();
    await work;
    await other;
    expect(connections.map(sqlTexts)).toEqual([
      [temporalSessionSql, "BEGIN", "SELECT 1", "SELECT 2", "COMMIT"],
      [temporalSessionSql, "SELECT 3"],
    ]);
    await client.close();
  });
});

describe("transaction cancellation and shutdown", () => {
  it("cancels the running statement, rolls back, then discards the session on abort", async () => {
    const rollback = deferred();
    const { client, connections } = setup({
      status: "RUNNING",
      sqlGates: { ROLLBACK: rollback.promise },
    });
    const controller = new AbortController();
    let statement!: Promise<unknown>;
    const pending = client.transaction(
      async (tx) => {
        statement = tx.query("UPDATE T SET X = 1").catch((error: unknown) => error);
        await statement;
      },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "ABORTED",
      message: "Transaction aborted",
      details: { completion: "unknown" },
    });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    controller.abort();
    await vi.waitFor(() => expect(sqlTexts(connections[0])).toContain("ROLLBACK"));
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    rollback.resolve();
    await rejected;
    expect(await statement).toMatchObject({ code: "ABORTED", details: { queryId: "query-1" } });
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "UPDATE T SET X = 1",
      "ROLLBACK",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("rolls back an aborted caller transaction before its deferred logout", async () => {
    const { client, connections } = setup(
      { status: "RUNNING" },
      { environment: "deployed", platform: "spcs" },
    );
    const caller = client.asCaller({
      headers: new Headers({ "sf-context-current-user-token": "alice" }),
    });
    const controller = new AbortController();
    const pending = caller.transaction(async (tx) => tx.query("UPDATE T SET X = 1"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(connections[0]?.config.token).toBe("test-token.alice");
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "UPDATE T SET X = 1",
      "ROLLBACK",
    ]);
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    expect(await client.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 0,
    });
    await client.close();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it("does not roll back after an abort whose cancellation can't be confirmed", async () => {
    const { client, connections } = setup({
      status: "RUNNING",
      cancelError: Error("synthetic cancel failure"),
    });
    const controller = new AbortController();
    const pending = client.transaction(async (tx) => tx.query("UPDATE T SET X = 1"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0])).toEqual([temporalSessionSql, "BEGIN", "UPDATE T SET X = 1"]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("tracks cancellation for each statement, not only the first", async () => {
    const { client, connections } = setup({ statuses: ["SUCCESS", "RUNNING"] });
    const controller = new AbortController();
    let second!: Promise<unknown>;
    const pending = client.transaction(
      async (tx) => {
        await tx.query("SELECT 1");
        second = tx.query("UPDATE T SET X = 1").catch((error: unknown) => error);
        await second;
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(connections[0]?.getQueryStatus.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(await second).toMatchObject({ code: "ABORTED", details: { completion: "unknown" } });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("rolls back when aborted between statements and refuses later ones", async () => {
    const { client, connections } = setup();
    const controller = new AbortController();
    const gate = deferred();
    const started = deferred();
    let late: Promise<unknown> | undefined;
    const pending = client.transaction(
      async (tx) => {
        await tx.query("INSERT INTO T VALUES (1)");
        started.resolve();
        await gate.promise;
        late = tx.query("INSERT INTO T VALUES (2)").catch((error: unknown) => error);
        await late;
      },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    gate.resolve();
    await vi.waitFor(() => expect(late).toBeDefined());
    expect(await late).toMatchObject({ code: "INVALID_OPTIONS", message: "Transaction has ended" });
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "ROLLBACK",
    ]);
    await client.close();
  });
  it("does not start when the signal is already aborted", async () => {
    const { client, connections } = setup();
    const callback = vi.fn(async () => {});
    await expect(
      client.transaction(callback, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it("discards the session when aborted before the callback starts", async () => {
    const begin = deferred();
    const controller = new AbortController();
    const { client, connections } = setup({ sqlGates: { BEGIN: begin.promise } });
    const callback = vi.fn(async () => {});
    const pending = client.transaction(callback, { signal: controller.signal });
    await vi.waitFor(() => expect(sqlTexts(connections[0])).toContain("BEGIN"));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "ABORTED",
      details: { completion: "not-submitted" },
    });
    begin.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("cancels only a statement whose own signal aborts", async () => {
    const submission = deferred();
    const { client, connections } = setup({
      sqlGates: { "UPDATE T SET X = 1": submission.promise },
    });
    const controller = new AbortController();
    await client.transaction(async (tx) => {
      const first = tx.query("UPDATE T SET X = 1", { signal: controller.signal });
      await vi.waitFor(() => expect(sqlTexts(connections[0])).toContain("UPDATE T SET X = 1"));
      controller.abort();
      await expect(first).rejects.toMatchObject({
        code: "ABORTED",
        details: { queryId: "query-1", completion: "unknown" },
      });
      await tx.query("SELECT 1");
    });
    submission.resolve();
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "UPDATE T SET X = 1",
      "SELECT 1",
      "COMMIT",
    ]);
    await client.close();
  });
  it("stops issuing SQL when a statement's cancellation cannot be confirmed", async () => {
    const { client, connections } = setup({
      status: "RUNNING",
      cancelError: Error("synthetic cancel failure"),
    });
    const handled = await client
      .transaction(async (tx) => {
        await expect(
          tx.query("UPDATE T SET X = 1", { waitTimeoutMs: 10, pollIntervalMs: 2 }),
        ).rejects.toMatchObject({
          code: "TIMEOUT",
          details: { queryId: "query-1", completion: "unknown" },
        });
        await expect(tx.query("SELECT 1")).rejects.toMatchObject({
          code: "QUERY_FAILED",
          details: { completion: "not-submitted" },
        });
      })
      .catch((error: unknown) => error);
    expect(handled).toMatchObject({
      code: "QUERY_FAILED",
      message: "Transaction was not committed because a statement may still be running",
      details: { completion: "unknown" },
    });
    const rethrown = await client
      .transaction(async (tx) => {
        await tx.query("UPDATE T SET X = 2", { waitTimeoutMs: 10, pollIntervalMs: 2 });
      })
      .catch((error: unknown) => error);
    expect(rethrown).toMatchObject({ code: "TIMEOUT" });
    expect(connections.map(sqlTexts)).toEqual([
      [temporalSessionSql, "BEGIN", "UPDATE T SET X = 1"],
      [temporalSessionSql, "BEGIN", "UPDATE T SET X = 2"],
    ]);
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("cancels the running statement and discards the session at forced shutdown", async () => {
    const { client, connections } = setup({ status: "RUNNING" });
    const pending = client.transaction(async (tx) => tx.query("UPDATE T SET X = 1"));
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    await expect(client.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(connections[0])).toEqual([temporalSessionSql, "BEGIN", "UPDATE T SET X = 1"]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
  });
  it("does not roll back a caller transaction at forced shutdown", async () => {
    const { client, connections } = setup(
      { status: "RUNNING" },
      { environment: "deployed", platform: "spcs" },
    );
    const caller = client.asCaller({ token: "alice" });
    const pending = caller.transaction(async (tx) => tx.query("UPDATE T SET X = 1"), {
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    await expect(client.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(connections[0]?.config.token).toBe("test-token.alice");
    expect(sqlTexts(connections[0])).toEqual([temporalSessionSql, "BEGIN", "UPDATE T SET X = 1"]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it("does not roll back when a standalone query client shuts down", async () => {
    const fake = fakeDriver({ status: "RUNNING" });
    const manager = createConnectionManager(
      createConnectionOptions([credentials()], { environment: "local" }),
      { driver: fake.driver },
    );
    const queries = createQueryClient(manager);
    const pending = queries.transaction(async (tx) => tx.query("UPDATE T SET X = 1"), {
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(fake.connections[0]?.getQueryStatus).toHaveBeenCalled());
    await expect(queries.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(fake.connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(sqlTexts(fake.connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "UPDATE T SET X = 1",
    ]);
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it.each(["client", "query client", "connection manager"] as const)(
    "does not roll back when the %s shuts down while the callback runs",
    async (closer) => {
      const fake = fakeDriver();
      const auth = createConnectionOptions([credentials()], { environment: "local" });
      const client = createSarClient({ driver: fake.driver, connectionOptions: auth });
      const manager = createConnectionManager(auth, { driver: fake.driver });
      const queries = createQueryClient(manager);
      const started = deferred();
      const pending = (closer === "client" ? client : queries).transaction(
        async () => {
          started.resolve();
          await new Promise<never>(() => {});
        },
        { signal: new AbortController().signal },
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      await started.promise;
      const target = closer === "client" ? client : closer === "query client" ? queries : manager;
      await expect(target.close({ timeoutMs: 1 })).rejects.toMatchObject({
        code: "SHUTDOWN_TIMEOUT",
      });
      await rejected;
      expect(sqlTexts(fake.connections[0])).toEqual([temporalSessionSql, "BEGIN"]);
      expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
      await Promise.allSettled([client.close(), queries.close()]);
      await manager.close().catch(() => {});
      await auth.close();
    },
  );
  it("lets a running transaction commit during the shutdown grace period", async () => {
    const { client, connections } = setup();
    const gate = deferred();
    const started = deferred();
    const work = client.transaction(async (tx) => {
      await tx.query("INSERT INTO T VALUES (1)");
      started.resolve();
      await gate.promise;
      return (await tx.query("SELECT 1")).rowCount;
    });
    await started.promise;
    const closing = client.close();
    await expect(client.transaction(async () => {})).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    gate.resolve();
    expect(await work).toBe(1);
    await closing;
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
});

describe("transaction scopes and sessions", () => {
  it("uses caller credentials and rolls back before the deferred caller logout", async () => {
    const { client, connections } = setup({}, { environment: "deployed", platform: "spcs" });
    const caller = client.asCaller({
      headers: new Headers({ "sf-context-current-user-token": "alice" }),
    });
    expect(await caller.transaction(async (tx) => (await tx.query("SELECT 1")).rowCount)).toBe(1);
    const failure = Error("synthetic application failure");
    await expect(
      caller.transaction(async (tx) => {
        await tx.query("INSERT INTO T VALUES (1)");
        throw failure;
      }),
    ).rejects.toBe(failure);
    await client.transaction(async (tx) => tx.query("SELECT 2"));
    expect(connections.map((connection) => connection.config.token)).toEqual([
      "test-token.alice",
      "test-token",
    ]);
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "SELECT 1",
      "COMMIT",
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "ROLLBACK",
    ]);
    expect(connections.map((connection) => connection.destroy.mock.calls.length)).toEqual([0, 1]);
    expect((await client.diagnostics()).physicalConnections).toBe(0);
    await client.close();
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
  });
  it("is available on standalone and caller-scoped query clients", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(
      createConnectionOptions([credentials()], { environment: "deployed", platform: "spcs" }),
      { driver: fake.driver },
    );
    const queries = createQueryClient(manager);
    const scoped = createQueryClient(manager.asCaller({ token: "bob" }));
    for (const scope of [queries, queries.asCaller({ token: "alice" }), scoped])
      await scope.transaction(async (tx) => tx.query("SELECT 1"));
    expect(fake.connections.map((connection) => connection.config.token)).toEqual([
      "test-token",
      "test-token.alice",
      "test-token.bob",
    ]);
    for (const connection of fake.connections)
      expect(sqlTexts(connection)).toEqual([temporalSessionSql, "BEGIN", "SELECT 1", "COMMIT"]);
    await Promise.all([queries.close(), scoped.close()]);
    await manager.close();
  });
  it("uses the transaction's warehouse for its session and every statement", async () => {
    const { client, connections } = setup();
    await client.transaction(
      async (tx) => {
        await tx.query("SELECT 1");
        await tx.query("SELECT 2");
      },
      { warehouse: "APP_WH" },
    );
    expect(connections[0]?.config.warehouse).toBe("APP_WH");
    const statements = executions(connections[0]).filter((execution) => execution.asyncExec);
    expect(statements).toHaveLength(2);
    for (const statement of statements)
      expect(statement.parameters).toMatchObject({ QUERY_WAREHOUSE_NAME: "APP_WH" });
    await client.close();
  });
  it("returns the session through reset after COMMIT or a successful ROLLBACK", async () => {
    const { connections, reset, manager, queries } = reusable();
    await queries.transaction(async (tx) => tx.query("INSERT INTO T VALUES (1)"));
    await expect(
      queries.transaction(async () => {
        throw Error("synthetic application failure");
      }),
    ).rejects.toThrow("synthetic application failure");
    await queries.query("SELECT 1");
    expect(connections).toHaveLength(1);
    expect(reset).toHaveBeenCalledTimes(3);
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "INSERT INTO T VALUES (1)",
      "COMMIT",
      temporalSessionSql,
      "BEGIN",
      "ROLLBACK",
      temporalSessionSql,
      "SELECT 1",
    ]);
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    await queries.close();
    await manager.close();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    [
      "a failed ROLLBACK",
      { sqlErrors: { ROLLBACK: Error("synthetic rollback failure") } },
      async (tx: Transaction) => {
        await tx.query("INSERT INTO T VALUES (1)");
        throw Error("synthetic application failure");
      },
      { message: "synthetic application failure" },
      ["ROLLBACK"],
    ],
    [
      "a failed COMMIT",
      { sqlErrors: { COMMIT: Error("synthetic commit failure") } },
      async (tx: Transaction) => {
        await tx.query("INSERT INTO T VALUES (1)");
      },
      { code: "QUERY_FAILED", details: { completion: "unknown" } },
      ["COMMIT"],
    ],
    [
      "an unconfirmed cancellation",
      { status: "RUNNING", cancelError: Error("synthetic cancel failure") },
      async (tx: Transaction) => {
        await tx.query("UPDATE T SET X = 1", { waitTimeoutMs: 10, pollIntervalMs: 2 });
      },
      { code: "TIMEOUT" },
      [],
    ],
  ] as const)("discards a reusable session after %s", async (...scenario) => {
    const [, fakeOptions, callback, expected, control] = scenario;
    const { connections, reset, manager, queries } = reusable(fakeOptions);
    await expect(queries.transaction(callback)).rejects.toMatchObject(expected);
    expect(
      sqlTexts(connections[0]).filter((sql) => sql === "COMMIT" || sql === "ROLLBACK"),
    ).toEqual(control);
    expect(reset).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(await manager.diagnostics()).toMatchObject({ idleConnections: 0, activeConnections: 0 });
    await queries.close();
    await manager.close();
  });
  it("rolls back and discards a reusable session when the transaction is aborted", async () => {
    const { connections, reset, manager, queries } = reusable({ status: "RUNNING" });
    const controller = new AbortController();
    const pending = queries.transaction(async (tx) => tx.query("UPDATE T SET X = 1"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(connections[0]?.getQueryStatus).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(sqlTexts(connections[0]).at(-1)).toBe("ROLLBACK");
    expect(reset).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await manager.diagnostics()).idleConnections).toBe(0);
    await queries.close();
    await manager.close();
  });
  it.each([
    ["a rejected callback", { message: "synthetic application failure" }],
    ["an aborted transaction", { code: "ABORTED" }],
  ] as const)(
    "bounds a ROLLBACK that does not finish after %s and discards the session",
    async (cause, expected) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const rollback = deferred();
      const started = deferred();
      const { connections, reset, manager, queries } = reusable({
        sqlGates: { ROLLBACK: rollback.promise },
      });
      const controller = new AbortController();
      const rejected = expect(
        queries.transaction(
          async () => {
            started.resolve();
            if (cause === "a rejected callback") throw Error("synthetic application failure");
            await new Promise<never>(() => {});
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject(expected);
      await started.promise;
      if (cause === "an aborted transaction") controller.abort();
      await vi.waitUntil(() => sqlTexts(connections[0]).includes("ROLLBACK"), { interval: 0 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(connections[0]?.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(reset).not.toHaveBeenCalled();
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
      rollback.resolve();
      await queries.close();
      await manager.close();
    },
  );
});

describe("transaction result formats", () => {
  it("sets JSON result formats once, before BEGIN, for every statement", async () => {
    const { client, connections } = setup();
    await client.transaction(async (tx) => {
      await tx.query("SELECT 1");
      await tx.query("SELECT 2", { rowMode: "array" });
      await tx.query("SELECT 3");
    });
    expect(sqlTexts(connections[0])).toEqual([
      temporalSessionSql,
      "BEGIN",
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
      "COMMIT",
    ]);
    const statements = executions(connections[0]).filter((execution) => execution.asyncExec);
    expect(statements.map((statement) => statement.fetchAsString)).toEqual([
      ["Number", "Date", "JSON"],
      ["Number", "Date", "JSON"],
      ["Number", "Date", "JSON"],
    ]);
    await client.close();
  });
  it("skips format setup for a native transaction on a JSON client", async () => {
    const { client, connections } = setup({ rows: [[42]] });
    const rows = await client.transaction(async (tx) => (await tx.query("SELECT 42")).rows, {
      format: "native",
    });
    expect(rows).toEqual([{ VALUE: 42 }]);
    expect(sqlTexts(connections[0])).toEqual(["BEGIN", "SELECT 42", "COMMIT"]);
    expect(executions(connections[0])[1]?.fetchAsString).toEqual([]);
    await client.close();
  });
  it("defaults to the client's format and lets a transaction choose JSON", async () => {
    const { client, connections } = setup({}, { results: { format: "native" } });
    await client.transaction(async (tx) => tx.query("SELECT 1"));
    const rows = await client.transaction(async (tx) => (await tx.query("SELECT 2")).rows, {
      format: "json",
    });
    expect(rows).toEqual([{ VALUE: "9007199254740993" }]);
    expect(connections.map(sqlTexts)).toEqual([
      ["BEGIN", "SELECT 1", "COMMIT"],
      [temporalSessionSql, "BEGIN", "SELECT 2", "COMMIT"],
    ]);
    const [native, json] = connections.map((connection) =>
      executions(connection).find((execution) => execution.asyncExec),
    );
    expect(native?.fetchAsString).toEqual([]);
    expect(json?.fetchAsString).toEqual(["Number", "Date", "JSON"]);
    await client.close();
  });
});

describe("transaction validation", () => {
  it.each([
    null,
    [],
    { waitTimeoutMs: 1_000 },
    { format: "csv" },
    { rowMode: "array" },
    { binds: [1] },
    { warehouse: "" },
    { warehouse: 1 },
    { signal: {} },
    { acquireTimeoutMs: 0 },
    { authTimeoutMs: 2 ** 32 },
  ])("rejects transaction options %j before acquiring a session", async (options) => {
    const { client, connections } = setup();
    const callback = vi.fn(async () => {});
    await expect(client.transaction(callback, options as TransactionOptions)).rejects.toMatchObject(
      { code: "INVALID_OPTIONS" },
    );
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it.each([
    ["", undefined],
    ["  ", undefined],
    [42, undefined],
    ["SELECT 1", null],
    ["SELECT 1", []],
    ["SELECT 1", { warehouse: "OTHER_WH" }],
    ["SELECT 1", { acquireTimeoutMs: 1_000 }],
    ["SELECT 1", { authTimeoutMs: 1_000 }],
    ["SELECT 1", { maxRows: 0 }],
    ["SELECT 1", { waitTimeoutMs: -1 }],
    ["SELECT 1", { signal: "abort" }],
    ["SELECT 1", { decodeRow: true }],
    ["SELECT 1", { format: "native" }],
    ["SELECT 1", { format: "json" }],
    ["SELECT 1", { format: "csv" }],
  ])("rejects statement %j with options %j without submitting it", async (sql, options) => {
    const { client, connections } = setup();
    await client.transaction(async (tx) => {
      await expect(
        tx.query(sql as string, options as TransactionQueryOptions),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    });
    expect(sqlTexts(connections[0])).toEqual([temporalSessionSql, "BEGIN", "COMMIT"]);
    await client.close();
  });
});
