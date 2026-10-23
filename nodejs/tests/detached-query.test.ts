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
import { createConnectionOptions, fromCredentials } from "../src/auth.js";
import { nextSteps, SarError } from "../src/errors.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient, type DetachedQueryScope } from "../src/queries.js";
import { fakeQueryService, deferred } from "./fake-query-service.js";
import { failedQueryError } from "./fake-driver.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup() {
  const service = fakeQueryService();
  let token = "synthetic-first";
  const owner = vi.fn(async () => ({ account: "test", authenticator: "OAUTH", token }));
  const caller = vi.fn(async () => ({
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
    caller,
    rotate: () => {
      token = "synthetic-next";
    },
  };
}

describe("cross-instance query retrieval", () => {
  it("polls pending work on a new client after the submitting client closes", async () => {
    const { create, queries, connections, owner, rotate } = setup();
    const first = create();
    const submitted = await first.submitDetached("synthetic");
    const reference = JSON.parse(JSON.stringify(submitted));
    await first.close();
    const second = create();
    const pending = { status: "pending", queryId: reference.queryId };
    expect(connections).toHaveLength(1);
    await expect(second.pollQuery(reference)).resolves.toEqual(pending);
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledExactlyOnceWith(reference.queryId);
    expect(connections[1]?.execute).toHaveBeenCalledOnce();
    expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
    expect(await second.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 0,
      idleConnections: 0,
    });
    queries.get(reference.queryId)!.status = "SUCCESS";
    rotate();
    await expect(second.pollQuery(reference)).resolves.toMatchObject({
      status: "complete",
      queryId: reference.queryId,
      result: { rows: [{ VALUE: "9007199254740993" }], rowCount: 1 },
    });
    expect(await second.getQueryStatus(reference)).toBe("SUCCESS");
    expect(owner).toHaveBeenCalledTimes(4);
    expect(connections[2]?.config.token).toBe("synthetic-next");
    expect(
      connections.every(
        (connection) =>
          connection.config.serverSessionKeepAlive &&
          connection.destroy.mock.calls.length === 1 &&
          connection.cancel.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(
      connections
        .flatMap((connection) => connection.execute.mock.calls)
        .filter(([options]) => options.asyncExec),
    ).toHaveLength(1);
    await second.close();
  });
  it("reattaches caller work after each previous client closes without using owner credentials", async () => {
    const { create, queries, connections, caller, owner, rotate } = setup();
    const first = create();
    const reference = JSON.parse(
      JSON.stringify(await first.asCaller({ token: "first" }).submitDetached("synthetic")),
    );
    await first.close();
    rotate();
    const second = create();
    expect((await second.asCaller({ token: "second" }).pollQuery(reference)).status).toBe(
      "pending",
    );
    await second.close();
    queries.get(reference.queryId)!.status = "SUCCESS";
    const third = create();
    expect((await third.asCaller({ token: "third" }).pollQuery(reference)).status).toBe("complete");
    await third.close();
    expect(owner).not.toHaveBeenCalled();
    expect(caller).toHaveBeenCalledTimes(3);
    expect(connections[1]?.config.token).toBe("caller-synthetic-next");
    expect(connections[2]?.config.token).toBe("caller-synthetic-next");
    expect(
      connections.slice(1).every((connection) => connection.getQueryStatus.mock.calls.length === 1),
    ).toBe(true);
    expect(connections.every((connection) => connection.destroy.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("uses saved result settings rather than a new client's defaults", async () => {
    const { create, settings } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic", { rowMode: "array" });
    const result = await client.pollQuery<string[]>(reference, {
      decodeRow: (row) => [...(row as string[]), "decoded"],
    });
    expect(result).toMatchObject({
      status: "complete",
      result: { rows: [["9007199254740993", "decoded"]] },
    });
    await client.close();
  });
  it.each(["organization", "account", "user", "role"] as const)(
    "rejects a different authenticated %s before target lookup",
    async (field) => {
      const { create, settings, connections } = setup();
      const client = create();
      const reference = await client.submitDetached("synthetic");
      settings.identity = { ...settings.identity, [field]: "OTHER" };
      for (const method of ["pollQuery", "getQueryStatus", "cancelQuery"] as const)
        await expect(client[method](reference)).rejects.toMatchObject({
          code: "QUERY_IDENTITY_MISMATCH",
        });
      expect(
        connections
          .slice(1)
          .every(
            (connection) =>
              connection.getQueryStatus.mock.calls.length === 0 &&
              connection.fetchResult.mock.calls.length === 0,
          ),
      ).toBe(true);
      await client.close();
    },
  );
  it("reacquires caller credentials without falling back to owner", async () => {
    const { create, caller, owner, settings, rotate } = setup();
    const client = create();
    const reference = await client.asCaller({ token: "first" }).submitDetached("synthetic");
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "QUERY_IDENTITY_MISMATCH",
    });
    await expect(
      client.asCaller({ headers: new Headers() }).pollQuery(reference),
    ).rejects.toMatchObject({ code: "CALLER_CONTEXT_REQUIRED" });
    rotate();
    settings.status = "SUCCESS";
    await client.asCaller({ token: "second" }).getQueryStatus(reference);
    caller.mockRejectedValueOnce(new SarError("AUTH_FAILED", "Synthetic rejection"));
    await expect(client.asCaller({ token: "third" }).pollQuery(reference)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      details: { queryId: reference.queryId, completion: "unknown" },
    });
    expect(caller).toHaveBeenCalledTimes(3);
    expect(owner).not.toHaveBeenCalled();
    await client.close();
  });
  it("does not use local/preview fallback for detached caller submissions", async () => {
    const fake = fakeQueryService();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(
        fromCredentials({
          target: { account: "test" },
          credential: { type: "oauth", token: "synthetic" },
        }),
        { environment: "local" },
      ),
    });
    await expect(
      client.asCaller({ headers: new Headers() }).submitDetached("synthetic"),
    ).rejects.toMatchObject({ code: "CALLER_CONTEXT_REQUIRED" });
    expect(fake.connections).toHaveLength(0);
    await client.close();
  });
  it.each(["FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"])(
    "surfaces terminal status %s rather than pending",
    async (status) => {
      const { create, settings } = setup();
      settings.status = status;
      const client = create();
      const reference = await client.submitDetached("synthetic");
      expect(await client.getQueryStatus(reference)).toBe(status);
      await expect(client.pollQuery(reference)).rejects.toMatchObject({
        code: "QUERY_FAILED",
        details: { completion: "failed" },
      });
      await client.close();
    },
  );
  it("reports Snowflake's error code for a failed detached query", async () => {
    const { create, settings } = setup();
    settings.status = "FAILED_WITH_ERROR";
    settings.queryError = failedQueryError(
      "002003",
      "Object 'REPORTS' does not exist or not authorized.",
      "SELECT * FROM REPORTS",
    );
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const error = await client.pollQuery(reference).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed (error 002003)",
      details: { queryId: reference.queryId, completion: "failed", errorCode: "002003" },
    });
    expect(JSON.stringify(error)).not.toContain("REPORTS");
    expect(inspect(error)).toContain("Object 'REPORTS' does not exist or not authorized.");
    expect(inspect(error)).not.toContain("SELECT * FROM REPORTS");
    await client.close();
  });
  it("reports unavailable results instead of polling forever", async () => {
    const { create, queries } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    queries.delete(reference.queryId);
    for (const method of ["pollQuery", "getQueryStatus", "cancelQuery"] as const)
      await expect(client[method](reference)).rejects.toMatchObject({
        code: "QUERY_UNAVAILABLE",
        details: { completion: "unknown" },
      });
    await client.close();
  });
  it("cancels only explicitly, binding the query ID", async () => {
    const { create, queries, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    await client.cancelQuery(reference);
    expect(queries.get(reference.queryId)?.status).toBe("ABORTED");
    const cancel = connections[1]?.execute.mock.calls.find(([options]) =>
      options.sqlText.startsWith("SELECT SYSTEM$CANCEL_QUERY"),
    )?.[0];
    expect(cancel).toMatchObject({
      sqlText: 'SELECT SYSTEM$CANCEL_QUERY(?) AS "status"',
      binds: [reference.queryId],
    });
    await client.cancelQuery(reference);
    expect(connections[2]?.execute.mock.calls).toHaveLength(1);
    await client.close();
  });
  it("does not hide cancellation failures", async () => {
    const { create, settings } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    settings.cancelError = Error("private driver error");
    await expect(client.cancelQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Query cancellation could not be confirmed",
    });
    await client.close();
  });
  it("names the missing caller grant when Snowflake refuses a caller's cancellation", async () => {
    const { create, settings } = setup();
    const client = create();
    const caller = client.asCaller({ token: "synthetic-caller" });
    const callerReference = await caller.submitDetached("synthetic");
    const ownerReference = await client.submitDetached("synthetic");
    settings.cancelError = Object.assign(new Error("private privilege detail"), {
      code: "003001",
      sqlState: "42501",
    });
    const callerError = await caller.cancelQuery(callerReference).catch((error: unknown) => error);
    expect(callerError).toMatchObject({
      code: "QUERY_FAILED",
      message: "Query cancellation could not be confirmed",
      details: {
        queryId: callerReference.queryId,
        completion: "unknown",
        errorCode: "003001",
        sqlState: "42501",
        nextStep: nextSteps.callerCancel,
      },
    });
    expect(JSON.stringify(callerError)).not.toContain("private privilege detail");
    const causes: unknown[] = [];
    for (let cause = (callerError as Error).cause; cause; cause = (cause as Error).cause)
      causes.push(cause);
    expect(causes).toContain(settings.cancelError);
    const ownerError = await client.cancelQuery(ownerReference).catch((error: unknown) => error);
    expect(ownerError).toMatchObject({ details: { errorCode: "003001", sqlState: "42501" } });
    expect((ownerError as SarError).details.nextStep).toBeUndefined();
    await client.close();
  });
});

describe("cancellation outcome", () => {
  const cancelRequests = (connections: ReturnType<typeof setup>["connections"]) =>
    connections
      .flatMap((connection) => connection.execute.mock.calls)
      .filter(([options]) => options.sqlText.startsWith("SELECT SYSTEM$CANCEL_QUERY"))
      .map(([options]) => options.binds);

  it("reports a running query as cancelled when Snowflake confirms termination", async () => {
    const { create, queries, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: true,
    });
    expect(cancelRequests(connections)).toEqual([[reference.queryId]]);
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(queries.get(reference.queryId)?.status).toBe("ABORTED");
    await client.close();
  });
  it("reports a confirmed cancellation that Snowflake records as FAILED_WITH_ERROR", async () => {
    const { create, settings, connections } = setup();
    settings.cancelledStatus = "FAILED_WITH_ERROR";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: true,
    });
    expect(connections[1]?.getQueryStatusThrowIfError).not.toHaveBeenCalled();
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: false,
      status: "FAILED_WITH_ERROR",
    });
    expect(connections[2]?.getQueryStatusThrowIfError).not.toHaveBeenCalled();
    expect(cancelRequests(connections)).toEqual([[reference.queryId]]);
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { queryId: reference.queryId, completion: "failed", errorCode: "000604" },
    });
    await client.close();
  });
  it.each(["SUCCESS", "FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"])(
    "reports an already %s query as not cancelled without requesting cancellation",
    async (status) => {
      const { create, settings, connections } = setup();
      settings.status = status;
      const client = create();
      const reference = await client.submitDetached("synthetic");
      expect(await client.cancelQuery(reference)).toEqual({
        queryId: reference.queryId,
        cancelled: false,
        status,
      });
      expect(cancelRequests(connections)).toEqual([]);
      expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
      await client.close();
    },
  );
  it.each(["SUCCESS", "FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT"])(
    "reports a query that ended with %s before cancellation took effect as not cancelled",
    async (status) => {
      const { create, settings, queries, connections } = setup();
      const client = create();
      const reference = await client.submitDetached("synthetic");
      settings.cancelResponse = [{ status: "synthetic unconfirmed response" }];
      settings.cancelKeepsRunning = true;
      settings.onCancel = () => {
        queries.get(reference.queryId)!.status = status;
      };
      expect(await client.cancelQuery(reference)).toEqual({
        queryId: reference.queryId,
        cancelled: false,
        status,
      });
      expect(cancelRequests(connections)).toEqual([[reference.queryId]]);
      expect(connections[1]?.getQueryStatus).toHaveBeenCalledTimes(2);
      await client.close();
    },
  );
  it("reports cancellation when the status after an unconfirmed request is ABORTED", async () => {
    const { create, settings, queries, connections } = setup();
    const client = create();
    const unconfirmed = await client.submitDetached("synthetic");
    settings.cancelResponse = [{ status: "synthetic unconfirmed response" }];
    expect(await client.cancelQuery(unconfirmed)).toEqual({
      queryId: unconfirmed.queryId,
      cancelled: true,
    });
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledTimes(2);
    const errored = await client.submitDetached("synthetic");
    settings.cancelError = Error("synthetic lost response");
    settings.onCancel = () => {
      queries.get(errored.queryId)!.status = "ABORTED";
    };
    expect(await client.cancelQuery(errored)).toEqual({
      queryId: errored.queryId,
      cancelled: true,
    });
    expect(connections[3]?.getQueryStatus).toHaveBeenCalledTimes(2);
    await client.close();
  });
  it("reports error 000604 after an unconfirmed request as cancelled", async () => {
    const { create, settings, connections } = setup();
    settings.cancelledStatus = "FAILED_WITH_ERROR";
    settings.cancelResponse = [{ status: "synthetic unconfirmed response" }];
    const client = create();
    const reference = await client.submitDetached("synthetic");
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: true,
    });
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledTimes(2);
    expect(connections[1]?.getQueryStatusThrowIfError).toHaveBeenCalledExactlyOnceWith(
      reference.queryId,
    );
    await client.close();
  });
  it("reports a statement timeout after an unconfirmed request as not cancelled", async () => {
    const { create, settings, queries, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    settings.cancelResponse = [{ status: "synthetic unconfirmed response" }];
    settings.cancelKeepsRunning = true;
    settings.onCancel = () => {
      const query = queries.get(reference.queryId)!;
      query.status = "FAILED_WITH_ERROR";
      query.error = failedQueryError(
        "000630",
        "Statement reached its statement or warehouse timeout of 1 second(s) and was canceled.",
        "synthetic",
      );
    };
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: false,
      status: "FAILED_WITH_ERROR",
    });
    expect(connections[1]?.getQueryStatusThrowIfError).toHaveBeenCalledOnce();
    await client.close();
  });
  it("reports an unreadable code after an unconfirmed request as not cancelled", async () => {
    const { create, settings, connections } = setup();
    settings.cancelledStatus = "FAILED_WITH_ERROR";
    settings.cancelResponse = [{ status: "synthetic unconfirmed response" }];
    settings.queryError = Error("synthetic lookup failure");
    const client = create();
    const reference = await client.submitDetached("synthetic");
    expect(await client.cancelQuery(reference)).toEqual({
      queryId: reference.queryId,
      cancelled: false,
      status: "FAILED_WITH_ERROR",
    });
    expect(connections[1]?.getQueryStatusThrowIfError).toHaveBeenCalledOnce();
    await client.close();
  });
  it("still rejects a reference from the other owner/caller mode before any lookup", async () => {
    const { create, connections } = setup();
    const client = create();
    const reference = await client.asCaller({ token: "synthetic" }).submitDetached("synthetic");
    await expect(client.cancelQuery(reference)).rejects.toMatchObject({
      code: "QUERY_IDENTITY_MISMATCH",
      message: "Query reference belongs to a different owner/caller mode",
    });
    expect(connections).toHaveLength(1);
    await client.close();
  });
  it("returns the same outcome from caller views and standalone query clients", async () => {
    const { create, provider, driver, queries } = setup();
    const client = create();
    const manager = createConnectionManager(provider, { driver });
    const standalone = createQueryClient(manager);
    const scoped = createQueryClient(manager.asCaller({ token: "synthetic" }));
    const scopes: DetachedQueryScope[] = [
      client.asCaller({ token: "synthetic" }),
      standalone,
      standalone.asCaller({ token: "synthetic" }),
      scoped,
    ];
    for (const scope of scopes) {
      const running = await scope.submitDetached("synthetic");
      const finished = await scope.submitDetached("synthetic");
      queries.get(finished.queryId)!.status = "SUCCESS";
      expect(await scope.cancelQuery(running)).toEqual({
        queryId: running.queryId,
        cancelled: true,
      });
      expect(await scope.cancelQuery(finished)).toEqual({
        queryId: finished.queryId,
        cancelled: false,
        status: "SUCCESS",
      });
    }
    await Promise.all([client.close(), standalone.close(), scoped.close()]);
    await manager.close();
  });
});

describe("single-check lookups only abandon local work", () => {
  it("returns pending without advancing time or scheduling another status check", async () => {
    vi.useFakeTimers();
    const { create, connections, queries } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const now = Date.now();
    expect(await client.pollQuery(reference)).toEqual({
      status: "pending",
      queryId: reference.queryId,
    });
    expect(Date.now()).toBe(now);
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(connections[1]?.execute).toHaveBeenCalledOnce();
    expect(connections[1]?.fetchResult).not.toHaveBeenCalled();
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveLength(2);
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
    await client.close();
  });
  it("allows reading a completed result beyond lookup and former short-wait limits", async () => {
    vi.useFakeTimers();
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = new Readable({ objectMode: true, read() {} });
    readable.push(["1"]);
    settings.readable = readable;
    let settled = false;
    const polling = client
      .pollQuery(reference, {
        lookupTimeoutMs: 100,
        consumeTimeoutMs: 10_000,
      })
      .finally(() => {
        settled = true;
      });
    const completed = expect(polling).resolves.toMatchObject({
      status: "complete",
      result: { rows: [{ VALUE: "1" }], rowCount: 1 },
    });
    await vi.waitFor(() => expect(connections[1]?.streams).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(settled).toBe(false);
    readable.push(null);
    await completed;
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(connections[1]?.fetchResult).toHaveBeenCalledOnce();
    expect(connections[1]?.cancel).not.toHaveBeenCalled();
    expect(connections[1]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it.each(["status", "fetch"] as const)(
    "throws on a slow %s lookup without cancellation and permits another request",
    async (phase) => {
      vi.useFakeTimers();
      const { create, settings, connections } = setup();
      settings.status = "SUCCESS";
      const client = create();
      const reference = await client.submitDetached("synthetic");
      const gate = deferred();
      settings[`${phase}Gate`] = gate.promise;
      const polling = client.pollQuery(reference, { lookupTimeoutMs: 100 });
      const rejected = expect(polling).rejects.toMatchObject({
        code: "TIMEOUT",
        details: {
          queryId: reference.queryId,
          completion: phase === "fetch" ? "succeeded" : "unknown",
        },
      });
      await vi.waitFor(() =>
        expect(
          phase === "status" ? connections[1]?.getQueryStatus : connections[1]?.fetchResult,
        ).toHaveBeenCalledOnce(),
      );
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
      expect(connections[1]?.cancel).not.toHaveBeenCalled();
      expect(connections[1]?.destroy).toHaveBeenCalledOnce();
      gate.resolve();
      settings[`${phase}Gate`] = undefined;
      expect((await client.pollQuery(reference)).status).toBe("complete");
      expect(connections[1]?.streams).toHaveLength(0);
      await client.close();
    },
  );
  it("closes partial results on consumption timeout and permits a fresh retrieval", async () => {
    vi.useFakeTimers();
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const readable = new Readable({ objectMode: true, read() {} });
    readable.push(["1"]);
    settings.readable = readable;
    const polling = client.pollQuery(reference, { consumeTimeoutMs: 100 });
    const rejected = expect(polling).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "succeeded", queryId: reference.queryId },
    });
    await vi.waitFor(() => expect(connections[1]?.streams).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    expect(readable.destroyed).toBe(true);
    expect(connections[1]?.cancel).not.toHaveBeenCalled();
    settings.readable = undefined;
    expect((await client.pollQuery(reference)).status).toBe("complete");
    await client.close();
  });
  it("does not turn driver failures or separate consume limits into pending", async () => {
    const { create, settings } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    settings.statusError = new SarError("TIMEOUT", "Synthetic driver timeout");
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Synthetic driver timeout",
    });
    settings.statusError = undefined;
    settings.fetchError = Error("sensitive backend result");
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "succeeded" },
    });
    settings.fetchError = undefined;
    settings.readable = new Readable({ objectMode: true, read() {} });
    await expect(client.pollQuery(reference, { consumeTimeoutMs: 5 })).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "succeeded" },
    });
    expect(settings.readable.destroyed).toBe(true);
    await client.close();
  });
  it("aborts a poll without cancelling the detached query", async () => {
    const { create, settings, connections, queries } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const gate = deferred();
    settings.statusGate = gate.promise;
    const controller = new AbortController();
    const pending = client.pollQuery(reference, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    gate.resolve();
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
    expect(connections[1]?.cancel).not.toHaveBeenCalled();
    await client.close();
  });
  it("keeps server success after a result limit failure", async () => {
    const { create, settings } = setup();
    settings.status = "SUCCESS";
    settings.rows = [["1"], ["2"]];
    const client = create();
    const reference = await client.submitDetached("synthetic", { maxRows: 1 });
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: { completion: "succeeded" },
    });
    expect(await client.getQueryStatus(reference)).toBe("SUCCESS");
    await client.close();
  });
});

describe("detached lookup boundaries", () => {
  it("rejects invalid driver statuses instead of returning pending", async () => {
    const { create, settings } = setup();
    settings.status = undefined as never;
    const client = create();
    const reference = await client.submitDetached("synthetic");
    // The shared fake maps absent status to NO_QUERY_DATA; an empty status tests malformed output.
    settings.status = "";
    const empty = await client.submitDetached("synthetic");
    await expect(client.getQueryStatus(empty)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    await expect(client.pollQuery(reference)).rejects.toMatchObject({ code: "QUERY_UNAVAILABLE" });
    await client.close();
  });
  it("rejects a mismatched result ID without returning another query's rows", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    settings.fetchedQueryId = "00000000-0000-0000-0000-000000000001";
    await expect(client.pollQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Result lookup returned a different query ID",
      details: { completion: "succeeded", queryId: reference.queryId },
    });
    expect(connections[1]?.streams).toHaveLength(0);
    await client.close();
  });
  it("handles cancellation completion races without claiming rollback", async () => {
    const { create, settings, queries } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    settings.cancelError = Error("synthetic already completed");
    settings.onCancel = () => {
      queries.get(reference.queryId)!.status = "SUCCESS";
    };
    await expect(client.cancelQuery(reference)).resolves.toEqual({
      queryId: reference.queryId,
      cancelled: false,
      status: "SUCCESS",
    });
    queries.get(reference.queryId)!.status = "RUNNING";
    settings.cancelError = undefined;
    settings.cancelKeepsRunning = true;
    settings.onCancel = undefined;
    settings.cancelResponse = [];
    await expect(client.cancelQuery(reference)).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "unknown" },
    });
    await client.close();
  });
  it("reports status without overriding a saved reference mutated during login", async () => {
    const { create, settings, connections } = setup();
    const client = create();
    const reference = JSON.parse(JSON.stringify(await client.submitDetached("synthetic")));
    const original = reference.queryId;
    const gate = deferred();
    settings.connectGate = gate.promise;
    const work = client.getQueryStatus(reference);
    reference.queryId = "00000000-0000-0000-0000-000000000000";
    reference.identity.role = "OTHER";
    gate.resolve();
    expect(await work).toBe("RUNNING");
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledWith(original);
    await client.close();
  });
  it.each(["FUTURE_STATUS", "BLOCKED", "ABORTING", "NO_DATA"])(
    "treats %s conservatively as pending",
    async (status) => {
      const { create, settings } = setup();
      settings.status = status;
      const client = create();
      const reference = await client.submitDetached("synthetic");
      expect((await client.pollQuery(reference)).status).toBe("pending");
      await client.close();
    },
  );
  it("uses standalone query components and preserves borrowed ownership", async () => {
    const { provider, driver, queries: registry } = setup();
    const manager = createConnectionManager(provider, { driver });
    const first = createQueryClient(manager);
    const reference = await first.submitDetached("synthetic");
    await first.close();
    await expect(first.pollQuery(reference)).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    const second = createQueryClient(manager);
    registry.get(reference.queryId)!.status = "SUCCESS";
    expect((await second.pollQuery(reference)).status).toBe("complete");
    const scoped = createQueryClient(manager.asCaller({ token: "synthetic" }));
    const callerReference = await scoped.submitDetached("synthetic");
    expect(callerReference.mode).toBe("caller");
    await scoped.cancelQuery(callerReference);
    await Promise.all([scoped.close(), second.close(), manager.close()]);
  });
  it("returns empty results and rejects decoder/conversion failures", async () => {
    const { create, settings, queries } = setup();
    settings.status = "SUCCESS";
    settings.rows = [];
    const client = create();
    const reference = await client.submitDetached("synthetic");
    await expect(client.pollQuery(reference)).resolves.toMatchObject({
      status: "complete",
      result: { rows: [], rowCount: 0 },
    });
    queries.get(reference.queryId)!.rows = [["1"]];
    await expect(
      client.pollQuery(reference, { decodeRow: async (row) => row }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    queries.get(reference.queryId)!.names = ["VALUE", "VALUE"];
    await expect(client.pollQuery(reference)).rejects.toMatchObject({ code: "DUPLICATE_COLUMNS" });
    await client.close();
  });
  it("preserves native retrieval settings and byte limits", async () => {
    const { create, settings } = setup();
    settings.status = "SUCCESS";
    settings.rows = [[1]];
    const client = create();
    const native = await client.submitDetached("synthetic", { format: "native", rowMode: "array" });
    await expect(client.pollQuery(native)).resolves.toMatchObject({ result: { rows: [[1]] } });
    settings.rows = [["a long value"]];
    settings.types = ["text"];
    const limited = await client.submitDetached("synthetic", { maxBytes: 1 });
    await expect(client.pollQuery(limited)).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
    await client.close();
  });
  it("stops synchronous decoding at the consumption deadline even before timers run", async () => {
    const { create, settings } = setup();
    settings.status = "SUCCESS";
    settings.rows = [["1"], ["2"]];
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    const decodeRow = vi.fn((row) => {
      clock.mockReturnValue(now + 101);
      return row;
    });
    await expect(
      client.pollQuery(reference, { consumeTimeoutMs: 100, decodeRow }),
    ).rejects.toMatchObject({ code: "TIMEOUT", details: { completion: "succeeded" } });
    expect(decodeRow).toHaveBeenCalledOnce();
    clock.mockRestore();
    await client.close();
  });
  it("shares the lookup deadline across status, format setup, and initial fetch", async () => {
    const { create, settings, connections } = setup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    settings.onStatus = () => {
      clock.mockReturnValue(now + 60);
    };
    settings.onFetch = () => {
      clock.mockReturnValue(now + 101);
    };
    await expect(client.pollQuery(reference, { lookupTimeoutMs: 100 })).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "succeeded", queryId: reference.queryId },
    });
    expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(connections[1]?.fetchResult).toHaveBeenCalledOnce();
    expect(connections[1]?.streams).toHaveLength(0);
    expect(connections[1]?.cancel).not.toHaveBeenCalled();
    clock.mockRestore();
    await client.close();
  });
  it("bounds identity and status lookups without returning pending on timeouts", async () => {
    vi.useFakeTimers();
    const { create, settings, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const identityGate = deferred();
    settings.controlGate = identityGate.promise;
    const pending = client.pollQuery(reference, { lookupTimeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.waitFor(() => expect(connections[1]?.execute).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    identityGate.resolve();
    settings.controlGate = undefined;
    const statusGate = deferred();
    settings.statusGate = statusGate.promise;
    const checking = client.getQueryStatus(reference, { lookupTimeoutMs: 100 });
    const timedOut = expect(checking).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.waitFor(() => expect(connections[2]?.getQueryStatus).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(150);
    await timedOut;
    statusGate.resolve();
    await client.close();
  });
  it("preserves detached work when shutdown interrupts an active poll", async () => {
    const { create, queries, connections, settings } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    const gate = deferred();
    settings.statusGate = gate.promise;
    const pending = client.pollQuery(reference);
    const aborted = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(connections[1]?.getQueryStatus).toHaveBeenCalledOnce());
    await expect(client.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await aborted;
    gate.resolve();
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
    expect(connections.every((connection) => connection.cancel.mock.calls.length === 0)).toBe(true);
  });
  it("does no I/O for invalid, closed, or preaborted polls", async () => {
    const { create, connections } = setup();
    const client = create();
    const reference = await client.submitDetached("synthetic");
    await expect(
      client.pollQuery(reference, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    for (const removed of [{ waitMs: 0 }, { waitMs: 2_000 }, { pollIntervalMs: 1_000 }])
      await expect(client.pollQuery(reference, removed as never)).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
    await expect(client.getQueryStatus({ ...reference, queryId: "invalid" })).rejects.toMatchObject(
      { code: "INVALID_OPTIONS" },
    );
    await client.close();
    await expect(client.pollQuery(reference)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(connections).toHaveLength(1);
  });
});
