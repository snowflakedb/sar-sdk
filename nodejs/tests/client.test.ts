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

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSarClient, getCallerUserToken, isSarError, SarError } from "../src/index.js";
import { nextSteps, snowflakeDetails } from "../src/errors.js";
import { createConnectionOptions, type ConnectionOptionsProvider } from "../src/auth.js";
import { failedQueryError, fakeDriver } from "./fake-driver.js";
import type { SarClientOptions } from "../src/types.js";

const connection = {
  account: "org-account",
  accessUrl: "https://org-account.snowflakecomputing.com",
  authenticator: "OAUTH",
  token: "test-token",
};
function setup(
  fakeOptions: Parameters<typeof fakeDriver>[0] = {},
  overrides: Pick<SarClientOptions, "pool" | "timeouts" | "results"> & {
    callerAsOwner?: boolean;
    connectionOptions?: ConnectionOptionsProvider;
  } = {},
) {
  const fake = fakeDriver(fakeOptions);
  const { callerAsOwner, connectionOptions, ...execution } = overrides;
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: connectionOptions ?? createConnectionOptions(connection, { callerAsOwner }),
    ...execution,
  });
  return { client, ...fake };
}
describe("client ownership", () => {
  it("does not read connection options during construction or diagnostics", async () => {
    const getOwnerOptions = vi.fn();
    const getCallerOptions = vi.fn();
    const client = createSarClient({ connectionOptions: { getOwnerOptions, getCallerOptions } });
    expect(getOwnerOptions).not.toHaveBeenCalled();
    expect(await client.diagnostics()).toEqual({
      sessionMode: "isolated",
      activeConnections: 0,
      queuedOperations: 0,
      idleConnections: 0,
      physicalConnections: 0,
    });
    expect(getOwnerOptions).not.toHaveBeenCalled();
    expect(getCallerOptions).not.toHaveBeenCalled();
    await client.close();
  });
  it("returns structured results with fresh sessions", async () => {
    const { client, connections } = setup();
    const first = await client.query("SELECT ?", { binds: [42], warehouse: "APP_WH" });
    expect(first).toMatchObject({
      rows: [{ VALUE: "9007199254740993" }],
      queryId: "query-1",
      rowCount: 1,
    });
    await client.query("SELECT 2");
    expect(connections).toHaveLength(2);
    expect(connections[0]?.config.warehouse).toBe("APP_WH");
    expect(connections[0]?.execute.mock.calls[0]?.[0].sqlText).toContain("ALTER SESSION SET");
    expect(connections[0]?.execute.mock.calls[1]?.[0]).toMatchObject({
      binds: [42],
      parameters: { MULTI_STATEMENT_COUNT: 1 },
    });
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
    await client.close();
    await expect(client.query("SELECT 3")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("uses a single total budget across handles", async () => {
    const { client, connections } = setup({}, { pool: { maxConnections: 1, maxQueue: 1 } });
    const handle = await client.submit("SELECT 1");
    const second = client.query("SELECT 2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connections).toHaveLength(1);
    expect((await client.diagnostics()).queuedOperations).toBe(1);
    await expect(client.query("SELECT 3")).rejects.toMatchObject({ code: "QUEUE_FULL" });
    await handle.result();
    await second;
    expect(connections).toHaveLength(2);
    await client.close();
  });
  it("does not replay a submitted statement on connection failure", async () => {
    const { client, connections } = setup({
      executeError: new Error("terminated connection with SECRET"),
    });
    await expect(client.query("INSERT INTO t VALUES (1)")).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "unknown" },
    });
    expect(
      connections[0]?.execute.mock.calls.filter(
        ([options]) => !options.sqlText.startsWith("ALTER SESSION SET"),
      ),
    ).toHaveLength(1);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("cleans up authentication completing after abort", async () => {
    let finishLogin!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const { client, connections } = setup({ connectGate });
    const controller = new AbortController();
    const pending = client.query("SELECT 1", { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    controller.abort();
    await rejected;
    finishLogin();
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("releases an exclusive raw session after callback failure", async () => {
    const { client, connections } = setup();
    await expect(
      client.withConnection(async () => {
        throw new Error("callback");
      }),
    ).rejects.toThrow("callback");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("bounds shutdown of abandoned handles and makes close idempotent", async () => {
    const { client, connections } = setup();
    await client.submit("SELECT 1");
    const closing = client.close({ timeoutMs: 1 });
    expect(client.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
});

describe("handles and streams", () => {
  it("does not submit user SQL when session formatting fails", async () => {
    const { client, connections } = setup({
      initializationError: new Error("private session error"),
    });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "not-submitted" },
    });
    expect(connections[0]?.execute).toHaveBeenCalledOnce();
    expect(connections[0]?.execute.mock.calls[0]?.[0].sqlText).toContain("ALTER SESSION SET");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("does not initialize formats for native conversion", async () => {
    const { client, connections } = setup({ rows: [[42]] });
    expect((await client.query("SELECT 42", { format: "native" })).rows).toEqual([{ VALUE: 42 }]);
    expect(connections[0]?.execute).toHaveBeenCalledOnce();
    expect(connections[0]?.execute.mock.calls[0]?.[0].sqlText).toBe("SELECT 42");
    await client.close();
  });
  it("releases cancellation that races with query completion", async () => {
    const { client, connections } = setup({ cancelError: new Error("not currently executing") });
    const handle = await client.submit("SELECT 1");
    await handle.cancel();
    await handle.cancel();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    await expect(handle.result()).rejects.toMatchObject({ code: "QUERY_FAILED" });
    await client.close();
  });
  it("does not hide cancellation failures for running queries", async () => {
    const { client, connections } = setup({
      status: "RUNNING",
      cancelError: new Error("private cause"),
    });
    const handle = await client.submit("SELECT 1");
    await expect(handle.cancel()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "unknown" },
    });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("names the missing caller grant when Snowflake refuses to cancel a caller's query", async () => {
    const refusal = Object.assign(new Error("private privilege detail"), {
      code: "003001",
      sqlState: "42501",
    });
    const { client } = setup({ status: "RUNNING", cancelError: refusal });
    const caller = await client.asCaller({ token: "synthetic-caller" }).submit("SELECT 1");
    const callerError = await caller.cancel().catch((error: unknown) => error);
    expect(callerError).toMatchObject({
      code: "QUERY_FAILED",
      message: "Query cancellation could not be confirmed",
      details: {
        completion: "unknown",
        errorCode: "003001",
        sqlState: "42501",
        nextStep: nextSteps.callerCancel,
      },
    });
    expect(JSON.stringify(callerError)).not.toContain("private privilege detail");
    const owner = await client.submit("SELECT 2");
    const ownerError = await owner.cancel().catch((error: unknown) => error);
    expect(ownerError).toMatchObject({ details: { errorCode: "003001", sqlState: "42501" } });
    expect((ownerError as SarError).details.nextStep).toBeUndefined();
    await client.close();
  });
  it("cancels a consumed handle without touching its destroyed connection", async () => {
    const { client, connections } = setup();
    const handle = await client.submit("SELECT 1");
    await handle.result();
    await handle.cancel();
    await handle.cancel();
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it.each(["query", "stream"] as const)(
    "waits for fetched metadata before %s results",
    async (method) => {
      let finishFetch!: () => void;
      const fetchGate = new Promise<void>((resolve) => {
        finishFetch = resolve;
      });
      const { client, connections } = setup({ fetchGate });
      const pending = client[method]("SELECT 1");
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(connections[0]?.execute).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      finishFetch();
      const result = await pending;
      expect(result.columns).toHaveLength(1);
      const rows: unknown[] = [];
      if ("rows" in result) rows.push(...result.rows);
      else for await (const row of result) rows.push(row);
      expect(rows).toEqual([{ VALUE: "9007199254740993" }]);
      await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
      await client.close();
    },
  );
  it.each(["fetchError", "fetchReject"] as const)("releases the session on %s", async (failure) => {
    const { client, connections } = setup({ [failure]: new Error("private-driver-message") });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("aborts a pending fetch and tolerates its late callback", async () => {
    let finishFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      finishFetch = resolve;
    });
    const { client, connections } = setup({ fetchGate });
    const controller = new AbortController();
    const pending = client.query("SELECT 1", { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[0]?.execute).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    finishFetch();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("preserves metadata on empty results", async () => {
    const { client } = setup({ rows: [] });
    const result = await client.query("SELECT 1 WHERE FALSE");
    expect(result.columns).toHaveLength(1);
    expect(result.rows).toEqual([]);
    await client.close();
  });
  it("marks a known server failure as failed rather than unknown", async () => {
    const { client } = setup({ status: "FAILED_WITH_ERROR" });
    await expect((await client.submit("SELECT invalid")).result()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "failed" },
    });
    await client.close();
  });
  it("rejects row width mismatches instead of dropping fields", async () => {
    const { client } = setup({ rows: [["1", "2"]] });
    await expect(client.query("SELECT 1, 2")).rejects.toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
    });
    await client.close();
  });
  it("rejects absent metadata instead of silently dropping fields", async () => {
    const { client } = setup({ missingMetadata: true });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
    });
    await client.close();
  });
  it("coalesces repeated results and never submits twice", async () => {
    const { client, connections } = setup();
    const handle = await client.submit("SELECT 1");
    const first = handle.result();
    expect(handle.result()).toBe(first);
    expect((await first).queryId).toBe(handle.queryId);
    expect(await handle.status()).toBe("SUCCESS");
    expect(
      connections[0]?.execute.mock.calls.filter(
        ([options]) => !options.sqlText.startsWith("ALTER SESSION SET"),
      ),
    ).toHaveLength(1);
    await client.close();
  });
  it("releases a stream when iteration breaks", async () => {
    const { client, connections } = setup({ rows: [["1"], ["2"]] });
    const stream = await client.stream("SELECT 1");
    for await (const row of stream) {
      expect(row).toEqual({ VALUE: "1" });
      break;
    }
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("cancels on wait timeout and reports query identity", async () => {
    const { client, connections } = setup({ status: "RUNNING" });
    await expect(
      client.query("SELECT 1", { waitTimeoutMs: 10, pollIntervalMs: 2 }),
    ).rejects.toMatchObject({ code: "TIMEOUT", details: { queryId: "query-1" } });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("enforces materialization limits during consumption", async () => {
    const { client, connections } = setup({ rows: [["1"], ["2"]] });
    await expect(client.query("SELECT 1", { maxRows: 1 })).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("detects duplicate columns and permits explicit arrays", async () => {
    const { client } = setup({ names: ["VALUE", "VALUE"], rows: [["1", "2"]] });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "DUPLICATE_COLUMNS" });
    expect((await client.query("SELECT 1", { rowMode: "array" })).rows).toEqual([["1", "2"]]);
    await client.close();
  });
  it("preserves nulls, binary, temporal and raw JSON text", async () => {
    const { client } = setup({
      names: ["EMPTY", "BINARY", "TIME", "DATA"],
      rows: [
        [
          null,
          Buffer.from("hello"),
          "2026-01-01T00:00:00.123456789",
          '{"number":9007199254740993}',
        ],
      ],
    });
    expect((await client.query("SELECT 1")).rows).toEqual([
      {
        EMPTY: null,
        BINARY: "aGVsbG8=",
        TIME: "2026-01-01T00:00:00.123456789",
        DATA: '{"number":9007199254740993}',
      },
    ]);
    await client.close();
  });
  it("rejects rounded numbers in JSON mode, permits native mode", async () => {
    const { client } = setup({ rows: [[123]] });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
    });
    expect((await client.query("SELECT 1", { format: "native" })).rows).toEqual([{ VALUE: 123 }]);
    await client.close();
  });
});

describe("caller boundaries", () => {
  it("extracts standard headers without validating their trust", () => {
    expect(getCallerUserToken(new Headers())).toBeNull();
    expect(getCallerUserToken(new Headers({ "Sf-Context-Current-User-Token": "token" }))).toBe(
      "token",
    );
  });
  it("rejects an absent caller token without reading connection options", async () => {
    const getOwnerOptions = vi.fn();
    const getCallerOptions = vi.fn();
    const { client, connections } = setup(
      {},
      { connectionOptions: { getOwnerOptions, getCallerOptions } },
    );
    expect(() => client.asCaller({ headers: new Headers() })).toThrow(
      expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
    );
    expect(getOwnerOptions).not.toHaveBeenCalled();
    expect(getCallerOptions).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it("runs a view without a caller token as the owner only with callerAsOwner", async () => {
    const { client, connections } = setup({}, { callerAsOwner: true });
    const caller = client.asCaller({ headers: new Headers() });
    expect("secrets" in caller).toBe(false);
    expect("close" in caller).toBe(false);
    await caller.query("SELECT 1");
    expect(connections[0]?.config.token).toBe("test-token");
    expect(() => client.asCaller({ token: "" })).toThrow();
    await client.close();
  });
  it("never exposes secrets on caller views", async () => {
    const { client } = setup();
    const caller = client.asCaller({ token: "alice" });
    expect("secrets" in caller).toBe(false);
    expect("close" in caller).toBe(false);
    expect(() => client.asCaller({ token: "" })).toThrow();
    await client.close();
  });
  it("isolates simultaneous callers", async () => {
    const { client, connections } = setup();
    await Promise.all([
      client.asCaller({ token: "alice" }).query("SELECT 1"),
      client.asCaller({ token: "bob" }).query("SELECT 1"),
    ]);
    expect(connections.map((connection) => connection.config.token).sort()).toEqual([
      "test-token.alice",
      "test-token.bob",
    ]);
    await client.close();
  });
  it("rejects a caller view when the connection has no token to append to", async () => {
    const { client, connections } = setup(
      {},
      { connectionOptions: createConnectionOptions({ account: "org-account", password: "x" }) },
    );
    await expect(client.asCaller({ token: "alice" }).query("SELECT 1")).rejects.toMatchObject({
      code: "AUTH_NOT_SUPPORTED",
    });
    expect(connections).toHaveLength(0);
    await client.close();
  });
});

describe("caller-scoped withConnection", () => {
  const callbackOnly =
    "withConnection takes only a callback; use asCaller({ headers }).withConnection(callback) for caller identity";
  const untyped = (target: object) =>
    target as { withConnection(...args: unknown[]): Promise<unknown> };
  it("rejects caller options and runs caller-view callbacks without changing owner identity", async () => {
    {
      const { client, connections } = setup();
      const headers = new Headers({ "sf-context-current-user-token": "alice" });
      const callback = vi.fn(async () => ({ value: 42 }));
      await expect(
        untyped(client).withConnection({ asCaller: true, headers }, callback),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS", message: callbackOnly });
      expect(callback).not.toHaveBeenCalled();
      expect(connections).toHaveLength(0);
      const result = await client.asCaller({ headers }).withConnection(callback);
      expect(result).toEqual({ value: 42 });
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]).toHaveLength(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ execute: expect.any(Function), destroy: expect.any(Function) }),
      );
      await client.withConnection(async () => undefined);
      expect(connections.map((connection) => connection.config.token)).toEqual([
        "test-token.alice",
        "test-token",
      ]);
      for (const connection of connections) expect(connection.execute).not.toHaveBeenCalled();
      expect(connections.map((connection) => connection.destroy.mock.calls.length)).toEqual([0, 1]);
      expect((await client.diagnostics()).activeConnections).toBe(0);
      await client.close();
      for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
    }
  });
  it("isolates overlapping owner and caller callbacks", async () => {
    const { client, connections } = setup();
    let finishCallbacks!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      finishCallbacks = resolve;
    });
    const pending = Promise.all([
      client
        .asCaller({ headers: new Headers({ "sf-context-current-user-token": "alice" }) })
        .withConnection(async () => callbackGate),
      client
        .asCaller({ headers: new Headers({ "sf-context-current-user-token": "bob" }) })
        .withConnection(async () => callbackGate),
      client.withConnection(async () => callbackGate),
    ]);
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    expect(connections.map((connection) => connection.config.token).sort()).toEqual([
      "test-token",
      "test-token.alice",
      "test-token.bob",
    ]);
    for (const connection of connections) expect(connection.destroy).not.toHaveBeenCalled();
    finishCallbacks();
    await pending;
    const loggedOut = () =>
      Object.fromEntries(
        connections.map((connection) => [
          connection.config.token,
          connection.destroy.mock.calls.length,
        ]),
      );
    expect(loggedOut()).toEqual({ "test-token": 1, "test-token.alice": 0, "test-token.bob": 0 });
    await client.close();
    expect(loggedOut()).toEqual({ "test-token": 1, "test-token.alice": 1, "test-token.bob": 1 });
  });
  it("shares the parent budget and retains a connection until the callback settles", async () => {
    const { client, connections } = setup({}, { pool: { maxConnections: 1, maxQueue: 1 } });
    let finishCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      finishCallback = resolve;
    });
    const first = client.withConnection(async () => callbackGate);
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const second = client
      .asCaller({ headers: new Headers({ "sf-context-current-user-token": "bob" }) })
      .withConnection(async () => "done");
    await vi.waitFor(async () => expect((await client.diagnostics()).queuedOperations).toBe(1));
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    finishCallback();
    await first;
    expect(await second).toBe("done");
    expect(connections.map((connection) => connection.config.token)).toEqual([
      "test-token",
      "test-token.bob",
    ]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(connections[1]?.destroy).not.toHaveBeenCalled();
    expect((await client.diagnostics()).physicalConnections).toBe(0);
    await client.close();
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
  });
  it("releases a caller connection when the callback throws", async () => {
    const { client, connections } = setup();
    await expect(
      client
        .asCaller({ headers: new Headers({ "sf-context-current-user-token": "alice" }) })
        .withConnection(async () => {
          throw new Error("callback failed");
        }),
    ).rejects.toThrow("callback failed");
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    expect(await client.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 0,
    });
    await client.close();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it("runs a view without a caller token as the owner with callerAsOwner", async () => {
    const { client, connections } = setup({}, { callerAsOwner: true });
    await client.asCaller({ headers: new Headers() }).withConnection(async () => undefined);
    expect(connections[0]?.config.token).toBe("test-token");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("rejects missing caller context before reading options or running the callback", async () => {
    const getOwnerOptions = vi.fn();
    const getCallerOptions = vi.fn();
    const { client, connections } = setup(
      {},
      { connectionOptions: { getOwnerOptions, getCallerOptions } },
    );
    const callback = vi.fn();
    expect(() => client.asCaller({ headers: new Headers() }).withConnection(callback)).toThrow(
      expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
    );
    expect(getOwnerOptions).not.toHaveBeenCalled();
    expect(getCallerOptions).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it("does not fall back or invoke the callback after caller options fail", async () => {
    const getCallerOptions = vi.fn(() => {
      throw new Error("credential rejected");
    });
    const getOwnerOptions = vi.fn(() => ({ ...connection }));
    const { client, connections } = setup(
      {},
      { connectionOptions: { getOwnerOptions, getCallerOptions } },
    );
    const callback = vi.fn();
    await expect(
      client
        .asCaller({ headers: new Headers({ "sf-context-current-user-token": "alice" }) })
        .withConnection(callback),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(getCallerOptions).toHaveBeenCalledOnce();
    expect(getOwnerOptions).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it.each([{}, { asCaller: false }] as const)(
    "rejects owner options and runs the bare callback as owner: %o",
    async (options) => {
      const { client, connections } = setup();
      const callback = vi.fn(async () => 42);
      await expect(untyped(client).withConnection(options, callback)).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
        message: callbackOnly,
      });
      expect(callback).not.toHaveBeenCalled();
      expect(connections).toHaveLength(0);
      expect(await client.withConnection(callback)).toBe(42);
      expect(connections[0]?.config.token).toBe("test-token");
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
      await client.close();
    },
  );
  it.each(
    [
      null,
      undefined,
      [],
      true,
      { asCaller: true, headers: new Headers() },
      { asCaller: "true", headers: new Headers() },
      { asCaller: true },
      { asCaller: true, headers: null },
      { asCaller: true, headers: {} },
      { asCaller: false, headers: new Headers() },
      { headers: new Headers() },
      { asCaller: true, headers: new Headers(), token: "alice" },
    ].map((options) => ({ options })),
  )("rejects scope options before acquiring a connection: %o", async ({ options }) => {
    const { client, connections } = setup();
    const callback = vi.fn();
    await expect(untyped(client).withConnection(options, callback)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: callbackOnly,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it.each([
    [{}, "Supply exactly one of headers or token"],
    [{ headers: new Headers(), token: "alice" }, "Supply exactly one of headers or token"],
    [{ headers: null }, "Caller headers must provide get(name)"],
    [{ headers: {} }, "Caller headers must provide get(name)"],
  ])(
    "rejects invalid caller contexts before acquiring a connection: %o",
    async (context, message) => {
      const { client, connections } = setup();
      expect(() => client.asCaller(context as never)).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS", message }),
      );
      expect(connections).toHaveLength(0);
      await client.close();
    },
  );
  it("rejects options after the callback instead of running it as owner", async () => {
    const { client, connections } = setup();
    const callback = vi.fn(async () => "owner");
    const headers = new Headers({ "sf-context-current-user-token": "alice" });
    for (const extra of [{ asCaller: true, headers }, {}, async () => undefined])
      await expect(untyped(client).withConnection(callback, extra)).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
        message: callbackOnly,
      });
    expect(callback).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    expect(await untyped(client).withConnection(callback, undefined)).toBe("owner");
    expect(connections.map((connection) => connection.config.token)).toEqual(["test-token"]);
    await client.close();
  });
  it("rejects missing callbacks and attempts to change an existing caller view", async () => {
    const { client, connections } = setup();
    const missing = undefined as unknown as () => Promise<void>;
    await expect(client.withConnection(missing)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: callbackOnly,
    });
    await expect(client.asCaller({ token: "bob" }).withConnection(missing)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "withConnection requires a callback",
    });
    const caller = client.asCaller({ token: "alice" });
    await expect(
      caller.withConnection({ asCaller: false } as unknown as () => Promise<void>),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(connections).toHaveLength(0);
    await client.close();
  });
  it("rejects new caller connections after parent shutdown", async () => {
    const { client, connections } = setup();
    const caller = client.asCaller({ token: "alice" });
    await client.close();
    expect(() => client.asCaller({ token: "bob" })).toThrow(
      expect.objectContaining({ code: "CLIENT_CLOSED" }),
    );
    await expect(caller.withConnection(async () => undefined)).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    expect(connections).toHaveLength(0);
  });
});

describe("caller session logout", () => {
  afterEach(() => vi.useRealTimers());
  function callerSetup(fakeOptions: Parameters<typeof fakeDriver>[0] = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = setup(fakeOptions);
    const view = (user: string) =>
      fake.client.asCaller({ headers: new Headers({ "sf-context-current-user-token": user }) });
    const loggedOut = () =>
      fake.connections.map((connection) => connection.destroy.mock.calls.length);
    return { ...fake, view, loggedOut };
  }
  function blocked(caller: ReturnType<ReturnType<typeof callerSetup>["view"]>) {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = caller.withConnection(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    return { started, done, release: () => release() };
  }

  it("reuses the view's session and logs it out once the view is idle", async () => {
    const { client, connections, view, loggedOut } = callerSetup();
    const alice = view("alice");
    const first = await alice.withConnection(async (connection) => connection);
    expect(await alice.withConnection(async (connection) => connection)).toBe(first);
    expect(connections.map((connection) => connection.config.token)).toEqual(["test-token.alice"]);
    expect(connections[0]?.connect).toHaveBeenCalledOnce();
    expect(loggedOut()).toEqual([0]);
    expect((await client.diagnostics()).physicalConnections).toBe(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(loggedOut()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(loggedOut()).toEqual([1]);
    await client.close();
    expect(loggedOut()).toEqual([1]);
  });
  it("postpones the logout while the view is active", async () => {
    const { client, connections, view, loggedOut } = callerSetup();
    const alice = view("alice");
    await alice.withConnection(async () => {});
    await vi.advanceTimersByTimeAsync(50_000);
    const busy = blocked(alice);
    await busy.started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loggedOut()).toEqual([0]);
    busy.release();
    await busy.done;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(loggedOut()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(loggedOut()).toEqual([1]);
    expect(connections).toHaveLength(1);
    await client.close();
  });
  it("times each view separately", async () => {
    const { client, connections, view, loggedOut } = callerSetup();
    await view("alice").withConnection(async () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await view("bob").withConnection(async () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connections.map((connection) => connection.config.token)).toEqual([
      "test-token.alice",
      "test-token.bob",
    ]);
    expect(loggedOut()).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loggedOut()).toEqual([1, 1]);
    await client.close();
  });
  it("tolerates a failed deferred logout", async () => {
    const { client, view, loggedOut } = callerSetup({ destroyError: Error("synthetic logout") });
    await view("alice").withConnection(async () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loggedOut()).toEqual([1]);
    await client.close();
  });
  it("logs out immediately without a caller token", async () => {
    const { client, connections } = setup({}, { callerAsOwner: true });
    await client.asCaller({ headers: new Headers() }).withConnection(async () => {});
    expect(connections[0]?.config.token).toBe("test-token");
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
});

describe("query failure details", () => {
  it("reports Snowflake's error code and keeps its message out of serialized output", async () => {
    const { client } = setup({
      status: "FAILED_WITH_ERROR",
      queryError: failedQueryError(
        "002003",
        "Object 'MISSING_TABLE' does not exist or not authorized.",
        "SELECT * FROM MISSING_TABLE WHERE TAX_ID = '123-45-6789'",
      ),
    });
    const error = await client.query("SELECT 1").catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed (error 002003)",
      details: { queryId: "query-1", completion: "failed", errorCode: "002003" },
    });
    expect(JSON.stringify(error)).not.toContain("MISSING_TABLE");
    expect(inspect(error)).toContain("Object 'MISSING_TABLE' does not exist or not authorized.");
    expect(inspect(error)).not.toContain("123-45-6789");
    await client.close();
  });
  it("keeps the generic failure when Snowflake gives no reason", async () => {
    const { client } = setup({ status: "FAILED_WITH_ERROR" });
    const error = await (await client.submit("SELECT 1")).result().catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed",
      details: { completion: "failed" },
    });
    expect(error).not.toHaveProperty("details.errorCode");
    expect(inspect(error)).not.toContain("driver-sensitive-error");
    await client.close();
  });
  it("carries driver codes from submission failures, and not from logins", async () => {
    const login = setup({
      connectError: Object.assign(Error("Invalid OAuth access token."), { code: "390303" }),
    });
    // The driver's pool reports a failed login by its message only.
    const error = await login.client.query("SELECT 1").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "AUTH_FAILED", details: { completion: "not-submitted" } });
    expect(error).not.toHaveProperty("details.errorCode");
    await login.client.close();
    const submission = setup({
      executeError: Object.assign(Error("SQL compilation error"), {
        code: "001003",
        sqlState: "42000",
      }),
    });
    await expect(submission.client.query("SELECT 1")).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { errorCode: "001003", sqlState: "42000" },
    });
    await submission.client.close();
  });
  it("only copies well-formed codes", () => {
    expect(
      snowflakeDetails(Object.assign(Error("x"), { code: 390303, sqlState: "08001" })),
    ).toEqual({
      errorCode: "390303",
      sqlState: "08001",
    });
    expect(
      snowflakeDetails(Object.assign(Error("x"), { code: "ECONNRESET", sqlState: "x" })),
    ).toEqual({});
    expect(snowflakeDetails(Object.assign(Error("x"), { code: -1 }))).toEqual({});
    expect(snowflakeDetails(new SarError("TIMEOUT", "Timed out"))).toEqual({});
    expect(snowflakeDetails("002003")).toEqual({});
  });
});

describe("query status polling", () => {
  afterEach(() => vi.useRealTimers());
  it("checks quickly at first and backs off to pollIntervalMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, connections } = setup({
      statuses: ["RUNNING", "RUNNING", "RUNNING", "RUNNING", "RUNNING", "SUCCESS"],
    });
    const result = client
      .submit("SELECT 1", { pollIntervalMs: 120 })
      .then((handle) => handle.result());
    const checks = () => connections[0]?.getQueryStatus.mock.calls.length ?? 0;
    await vi.waitUntil(() => checks() === 1, { interval: 0 });
    for (const [elapsed, expected] of [
      [24, 1],
      [1, 2],
      [50, 3],
      [100, 4],
      [119, 4],
      [1, 5],
      [120, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(checks()).toBe(expected);
    }
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ rowCount: 1 });
    await client.close();
  });
});

describe("public validation", () => {
  it("rejects unknown options and driver identity overrides", () => {
    for (const removed of [
      { driverOptions: { token: "bad" } },
      { connection: { account: "x" } },
      { environment: "local" },
      { platform: "spcs" },
      { callerFallback: "error" },
      { timeouts: { authMs: 1 } },
    ])
      expect(() => createSarClient(removed as unknown as SarClientOptions)).toThrow();
    expect(() => createSarClient({ pool: { maxConnections: 0 } })).toThrow();
    expect(() =>
      createSarClient({ results: { format: "wrong" } } as unknown as SarClientOptions),
    ).toThrow();
  });
  it("serializes errors without secret-bearing causes", () => {
    const error = new SarError("AUTH_FAILED", "Authentication failed", {}, new Error("secret"));
    expect(isSarError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
