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
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSarClient } from "../src/index.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { temporalSessionSql } from "../src/query-client/results.js";
import type { QueryStreamResult, RowStream, SarClient } from "../src/index.js";
import { failedQueryError } from "./fake-driver.js";
import { deferred, fakeQueryService } from "./fake-query-service.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup() {
  const service = fakeQueryService();
  let token = "synthetic-first";
  const owner = vi.fn(() => ({ account: "test", authenticator: "OAUTH", token }));
  const caller = vi.fn(() => ({
    account: "test",
    authenticator: "OAUTH",
    token: `caller-${token}`,
  }));
  const provider = { getOwnerOptions: owner, getCallerOptions: caller };
  const create = () => createSarClient({ connectionOptions: provider, driver: service.driver });
  return {
    ...service,
    create,
    provider,
    owner,
    rotate: () => {
      token = "synthetic-next";
    },
  };
}
function streamOf<Row>(outcome: QueryStreamResult<Row>): RowStream<Row> {
  if (outcome.status !== "complete") throw new Error("Expected a complete result");
  return outcome.stream;
}
async function collect<Row>(stream: RowStream<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of stream) rows.push(row);
  return rows;
}
/** A driver row stream that stays open after the given rows. */
function openRows(...rows: unknown[][]) {
  const readable = new Readable({ objectMode: true, read() {} });
  for (const row of rows) readable.push(row);
  return readable;
}
async function expectReleased(client: Pick<SarClient, "diagnostics">) {
  expect(await client.diagnostics()).toMatchObject({
    activeConnections: 0,
    physicalConnections: 0,
    idleConnections: 0,
  });
}
/** An exhausted stream releases its session in the background. */
async function expectReleasedAfterExhaustion(client: Pick<SarClient, "diagnostics">) {
  await vi.waitFor(() => expectReleased(client));
}
/** Detached lookups never cancel the query or delete its retained server session. */
function expectDetachedCleanup(connections: ReturnType<typeof fakeQueryService>["connections"]) {
  for (const connection of connections) {
    expect(connection.config.serverSessionKeepAlive).toBe(true);
    expect(connection.cancel).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(
      connection.execute.mock.calls.some(([options]) =>
        options.sqlText.startsWith("SELECT SYSTEM$CANCEL_QUERY"),
      ),
    ).toBe(false);
  }
}

describe("streamQuery checks once and streams completed results", () => {
  it("returns pending after one status check without fetching or scheduling work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { create, connections, queries } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    await expect(client.streamQuery(reference)).resolves.toEqual({
      status: "pending",
      queryId: reference.queryId,
    });
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledExactlyOnceWith(reference.queryId);
    expect(connections[1]?.execute).toHaveBeenCalledOnce();
    expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
    expect(connections[1]?.streams).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(2);
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("streams every row beyond the reference's materialization limits", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    settings.rows = Array.from({ length: 5 }, (_, index) => [String(index)]);
    const client = create();
    const reference = await client.submitDetached("synthetic", { maxRows: 2, maxBytes: 16 });
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
    const outcome = await client.streamQuery(reference);
    expect(outcome).toMatchObject({ status: "complete", queryId: reference.queryId });
    const stream = streamOf(outcome);
    expect(stream.queryId).toBe(reference.queryId);
    expect(stream.columns).toMatchObject([{ name: "VALUE", type: "fixed", index: 0 }]);
    expect(await collect(stream)).toEqual(settings.rows.map(([value]) => ({ VALUE: value })));
    expect(connections[2]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(connections[2]?.fetchResult).toHaveBeenCalledOnce();
    await expectReleasedAfterExhaustion(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("sets JSON temporal formats on the lookup session before fetching", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const json = await client.submitDetached("synthetic");
    const native = await client.submitDetached("synthetic", { format: "native" });
    await collect(streamOf(await client.streamQuery(json)));
    await collect(streamOf(await client.streamQuery(native)));
    const [jsonLookup, nativeLookup] = [connections[2]!, connections[3]!];
    const statements = (lookup: typeof jsonLookup) =>
      lookup.execute.mock.calls.map(([options]) => options.sqlText);
    const identity = expect.stringMatching(/^SELECT CURRENT_ORGANIZATION_NAME/);
    expect(statements(jsonLookup)).toEqual([identity, temporalSessionSql]);
    expect(jsonLookup.execute.mock.invocationCallOrder[1]).toBeLessThan(
      jsonLookup.fetchResult.mock.invocationCallOrder[0]!,
    );
    expect(jsonLookup.fetchResult).toHaveBeenCalledWith(
      expect.objectContaining({ queryId: json.queryId, fetchAsString: ["Number", "Date", "JSON"] }),
    );
    expect(statements(nativeLookup)).toEqual([identity]);
    expect(nativeLookup.fetchResult).toHaveBeenCalledWith(
      expect.objectContaining({ queryId: native.queryId, fetchAsString: [] }),
    );
    await client.close();
  });
  it("streams saved native array rows through the request's decoder", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    settings.rows = [[1], [2]];
    const client = create();
    const reference = await client.submitDetached("synthetic", {
      format: "native",
      rowMode: "array",
    });
    const decodeRow = vi.fn((row: unknown) => [...(row as number[]), "decoded"]);
    const stream = streamOf(await client.streamQuery<unknown[]>(reference, { decodeRow }));
    expect(await collect(stream)).toEqual([
      [1, "decoded"],
      [2, "decoded"],
    ]);
    expect(decodeRow).toHaveBeenCalledTimes(2);
    const asynchronous = streamOf(
      await client.streamQuery(reference, { decodeRow: async (row) => row }),
    );
    await expect(collect(asynchronous)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("streams a result submitted by a client that has since closed", async () => {
    const { create, queries, connections, rotate } = setup();
    const first = create();
    const reference = JSON.parse(JSON.stringify(await first.submitDetached("synthetic")));
    await first.close();
    const second = create();
    await expect(second.streamQuery(reference)).resolves.toEqual({
      status: "pending",
      queryId: reference.queryId,
    });
    await second.close();
    queries.get(reference.queryId)!.status = "SUCCESS";
    rotate();
    const third = create();
    const stream = streamOf(await third.streamQuery(reference));
    expect(stream.queryId).toBe(reference.queryId);
    expect(await collect(stream)).toEqual([{ VALUE: "9007199254740993" }]);
    await third.close();
    expect(connections).toHaveLength(3);
    expect(connections[2]?.config.token).toBe("synthetic-next");
    expect(
      connections
        .flatMap((connection) => connection.execute.mock.calls)
        .filter(([options]) => options.asyncExec),
    ).toHaveLength(1);
    expectDetachedCleanup(connections);
  });
  it("streams through caller-scoped standalone query clients", async () => {
    const { provider, driver, queries, connections, owner } = setup();
    const manager = createConnectionManager(provider, { driver });
    const submitter = createQueryClient(manager.asCaller({ token: "synthetic" }));
    const reference = await submitter.submitDetached("synthetic");
    await submitter.close();
    queries.get(reference.queryId)!.status = "SUCCESS";
    const reader = createQueryClient(manager);
    await expect(reader.streamQuery(reference)).rejects.toMatchObject({
      code: "QUERY_IDENTITY_MISMATCH",
    });
    const stream = streamOf(await reader.asCaller({ token: "synthetic" }).streamQuery(reference));
    expect(await collect(stream)).toEqual([{ VALUE: "9007199254740993" }]);
    await reader.close();
    await manager.close();
    expect(owner).not.toHaveBeenCalled();
    expectDetachedCleanup(connections);
  });
});

describe("a complete stream owns its lookup connection", () => {
  it.each(["exhausted", "broken out of", "closed"] as const)(
    "holds the connection until the stream is %s",
    async (ending) => {
      const { create, settings, connections, queries } = setup();
      settings.status = "SUCCESS";
      settings.rows = [["1"], ["2"]];
      const client = create();
      const reference = await client.submitDetached("synthetic");
      const stream = streamOf(await client.streamQuery(reference));
      expect(await client.diagnostics()).toMatchObject({
        activeConnections: 1,
        physicalConnections: 1,
      });
      expect(connections[1]?.destroy).not.toHaveBeenCalled();
      if (ending === "exhausted")
        expect(await collect(stream)).toEqual([{ VALUE: "1" }, { VALUE: "2" }]);
      else if (ending === "broken out of")
        for await (const row of stream) {
          expect(row).toEqual({ VALUE: "1" });
          break;
        }
      else await stream.close();
      expect(connections[1]?.streams[0]?.destroyed).toBe(true);
      if (ending === "exhausted") await expectReleasedAfterExhaustion(client);
      else await expectReleased(client);
      expectDetachedCleanup(connections);
      expect(queries.get(reference.queryId)?.status).toBe("SUCCESS");
      await client.close();
    },
  );
  it("aborts consumption through the options signal without cancelling the query", async () => {
    const { create, settings, connections, queries } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const controller = new AbortController();
    const iterator = streamOf(await client.streamQuery(reference, { signal: controller.signal }))[
      Symbol.asyncIterator
    ]();
    expect(await iterator.next()).toEqual({ done: false, value: { VALUE: "1" } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "ABORTED",
      message: "Result consumption aborted",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    expect(readable.destroyed).toBe(true);
    await expectReleased(client);
    expectDetachedCleanup(connections);
    expect(queries.get(reference.queryId)?.status).toBe("SUCCESS");
    await client.close();
  });
  it("bounds consumption with consumeTimeoutMs rather than lookupTimeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const iterator = streamOf(
      await client.streamQuery(reference, { lookupTimeoutMs: 100, consumeTimeoutMs: 10_000 }),
    )[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { VALUE: "1" } });
    let settled = false;
    const pending = iterator.next().finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Result consumption deadline exceeded",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(connections[1]?.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(readable.destroyed).toBe(true);
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("releases an abandoned stream's connection at the consumption deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const stream = streamOf(await client.streamQuery(reference, { consumeTimeoutMs: 100 }));
    expect(await client.diagnostics()).toMatchObject({ activeConnections: 1 });
    await vi.advanceTimersByTimeAsync(150);
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
    await expectReleased(client);
    await expect(collect(stream)).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("lets an open stream finish during the client's shutdown grace period", async () => {
    const { create, settings, connections, queries } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const stream = streamOf(await client.streamQuery(reference));
    const closing = client.close();
    await expect(client.streamQuery(reference)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(connections[1]?.destroy).not.toHaveBeenCalled();
    readable.push(["2"]);
    readable.push(null);
    expect(await collect(stream)).toEqual([{ VALUE: "1" }, { VALUE: "2" }]);
    await closing;
    expect(connections).toHaveLength(2);
    expectDetachedCleanup(connections);
    expect(queries.get(reference.queryId)?.status).toBe("SUCCESS");
  });
  it("aborts an open stream without cancelling when shutdown's grace period ends", async () => {
    const { create, settings, connections, queries } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const iterator = streamOf(await client.streamQuery(reference))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { VALUE: "1" } });
    const aborted = expect(iterator.next()).rejects.toMatchObject({
      code: "ABORTED",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    await expect(client.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await aborted;
    expect(readable.destroyed).toBe(true);
    await expectReleased(client);
    expectDetachedCleanup(connections);
    expect(queries.get(reference.queryId)?.status).toBe("SUCCESS");
  });
  it("aborts a standalone query client's stream on close without closing its manager", async () => {
    const { provider, driver, settings, connections } = setup();
    settings.status = "SUCCESS";
    const manager = createConnectionManager(provider, { driver });
    const queries = createQueryClient(manager);
    const reference = await queries.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const iterator = streamOf(await queries.streamQuery(reference))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { VALUE: "1" } });
    const aborted = expect(iterator.next()).rejects.toMatchObject({
      code: "ABORTED",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    await expect(queries.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await aborted;
    expect(readable.destroyed).toBe(true);
    await expectReleased(manager);
    const next = createQueryClient(manager);
    await expect(next.getQueryStatus(reference)).resolves.toBe("SUCCESS");
    await next.close();
    await manager.close();
    expectDetachedCleanup(connections);
  });
  it("allows a single consumer", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    settings.rows = [["1"], ["2"]];
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const stream = streamOf(await client.streamQuery(reference));
    const first = stream[Symbol.asyncIterator]();
    expect(await first.next()).toEqual({ done: false, value: { VALUE: "1" } });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "Row stream can only be consumed once",
    });
    expect(await first.next()).toEqual({ done: false, value: { VALUE: "2" } });
    expect(await first.next()).toEqual({ done: true, value: undefined });
    await expect(collect(stream)).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expectReleasedAfterExhaustion(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("throws instead of ending early when the result stream fails partway", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = openRows(["1"]);
    settings.readable = readable;
    const iterator = streamOf(await client.streamQuery(reference))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { VALUE: "1" } });
    const pending = iterator.next();
    readable.destroy(Error("private chunk failure"));
    const error = await pending.catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Result consumption failed",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    expect(JSON.stringify(error)).not.toContain("private");
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
});

describe("streamQuery fails like pollQuery before returning a stream", () => {
  it.each(["organization", "account", "user", "role"] as const)(
    "rejects a different authenticated %s before checking status",
    async (field) => {
      const { create, settings, connections } = setup();
      settings.status = "SUCCESS";
      const client = create();
      const reference = await client.submitDetached("synthetic");
      settings.identity = { ...settings.identity, [field]: "OTHER" };
      await expect(client.streamQuery(reference)).rejects.toMatchObject({
        code: "QUERY_IDENTITY_MISMATCH",
        details: { queryId: reference.queryId, completion: "unknown" },
      });
      expect(connections[1]?.getQueryStatus).not.toHaveBeenCalled();
      expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
      await expectReleased(client);
      expectDetachedCleanup(connections);
      await client.close();
    },
  );
  it("checks owner/caller mode and caller context before connecting", async () => {
    const { create, connections, queries, owner } = setup();
    const client = create();
    const ownerReference = await client.submitDetached("synthetic");
    const callerReference = await client.asCaller({ token: "first" }).submitDetached("synthetic");
    expect(connections).toHaveLength(2);
    await expect(client.streamQuery(callerReference)).rejects.toMatchObject({
      code: "QUERY_IDENTITY_MISMATCH",
    });
    await expect(
      client.asCaller({ token: "second" }).streamQuery(ownerReference),
    ).rejects.toMatchObject({ code: "QUERY_IDENTITY_MISMATCH" });
    expect(() => client.asCaller({ headers: new Headers() })).toThrow(
      expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
    );
    expect(connections).toHaveLength(2);
    queries.get(callerReference.queryId)!.status = "SUCCESS";
    const stream = streamOf(await client.asCaller({ token: "third" }).streamQuery(callerReference));
    expect(await collect(stream)).toEqual([{ VALUE: "9007199254740993" }]);
    expect(owner).toHaveBeenCalledOnce();
    expect(connections[2]?.config.token).toBe("caller-synthetic-first");
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("reports an unavailable query instead of pending", async () => {
    const { create, queries, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    queries.delete(reference.queryId);
    await expect(client.streamQuery(reference)).rejects.toMatchObject({
      code: "QUERY_UNAVAILABLE",
      details: { queryId: reference.queryId, completion: "unknown" },
    });
    expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it.each(["FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"])(
    "throws for terminal status %s without fetching",
    async (status) => {
      const { create, settings, connections } = setup();
      settings.status = status;
      const client = create();
      const reference = await client.submitDetached("synthetic");
      await expect(client.streamQuery(reference)).rejects.toMatchObject({
        code: "QUERY_FAILED",
        details: { queryId: reference.queryId, completion: "failed" },
      });
      expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
      await expectReleased(client);
      expectDetachedCleanup(connections);
      await client.close();
    },
  );
  it("reports the same Snowflake error details as pollQuery", async () => {
    const { create, settings, connections } = setup();
    settings.status = "FAILED_WITH_ERROR";
    settings.queryError = failedQueryError(
      "002003",
      "Object 'REPORTS' does not exist or not authorized.",
      "SELECT * FROM REPORTS",
    );
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const polled = await client.pollQuery(reference).catch((error: unknown) => error);
    const streamed = await client.streamQuery(reference).catch((error: unknown) => error);
    expect(streamed).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed (error 002003)",
      details: { queryId: reference.queryId, completion: "failed", errorCode: "002003" },
    });
    expect(JSON.stringify(streamed)).toBe(JSON.stringify(polled));
    expect(JSON.stringify(streamed)).not.toContain("REPORTS");
    expect(inspect(streamed)).toContain("Object 'REPORTS' does not exist or not authorized.");
    expect(inspect(streamed)).not.toContain("SELECT * FROM REPORTS");
    expect(connections[2]?.fetchResult).not.toHaveBeenCalled();
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("abandons a slow fetch on abort and ignores its late completion", async () => {
    const { create, settings, connections, queries } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const gate = deferred();
    settings.fetchGate = gate.promise;
    const fetched = vi.fn();
    settings.onFetch = fetched;
    const controller = new AbortController();
    const pending = client.streamQuery(reference, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "ABORTED",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    await vi.waitFor(() => expect(connections[1]?.fetchResult).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
    gate.resolve();
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledOnce());
    expect(connections[1]?.streams).toHaveLength(0);
    await expectReleased(client);
    expectDetachedCleanup(connections);
    expect(queries.get(reference.queryId)?.status).toBe("SUCCESS");
    await client.close();
  });
  it("releases the connection when a fetched result cannot be streamed", async () => {
    const { create, settings, connections, queries } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    queries.get(reference.queryId)!.names = ["VALUE", "VALUE"];
    await expect(client.streamQuery(reference)).rejects.toMatchObject({
      code: "DUPLICATE_COLUMNS",
      details: { queryId: reference.queryId, completion: "succeeded" },
    });
    expect(connections[1]?.streams).toHaveLength(0);
    await expectReleased(client);
    expectDetachedCleanup(connections);
    await client.close();
  });
  it("does no I/O for invalid, preaborted, or closed requests", async () => {
    const { create, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    await expect(
      client.streamQuery(reference, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    for (const invalid of [
      { waitMs: 0 },
      { maxRows: 1_000_000 },
      { format: "native" },
      { consumeTimeoutMs: 0 },
      { decodeRow: "identity" },
    ])
      await expect(client.streamQuery(reference, invalid as never)).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
    await expect(client.streamQuery({ ...reference, queryId: "invalid" })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await client.close();
    await expect(client.streamQuery(reference)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(connections).toHaveLength(1);
  });
});
