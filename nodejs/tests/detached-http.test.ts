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

import { describe, expect, it, vi } from "vitest";
import {
  detachedHttpHandlers,
  type QueryRecord,
  type DetachedHttpDependencies,
} from "../examples/detached-http.js";
import { SarError } from "../src/core/errors.js";
import { createSarClient } from "../src/index.js";
import type { QueryCancellation, QueryReference, SarClient } from "../src/index.js";
import { deferred, fakeQueryService } from "./fake-query-service.js";

function setup() {
  const reference: QueryReference = {
    version: 1,
    queryId: "01000000-0000-0000-0000-00000000abcd",
    submittedAt: "2026-09-29T00:00:00.000Z",
    identity: { organization: "ORG", account: "ACCOUNT", user: "USER", role: "ROLE" },
    mode: "caller",
    results: { format: "json", rowMode: "object", maxRows: 100_000, maxBytes: 32 * 1024 * 1024 },
  };
  const record: QueryRecord = {
    application: "app",
    subject: "subject",
    expiresAt: Date.now() + 60_000,
    decoder: "identity-v1",
    reference,
  };
  const events: string[] = [];
  const submitDetached = vi.fn(async () => {
    events.push("submit");
    return reference;
  });
  const pollQuery = vi.fn(async () => {
    events.push("poll");
    return { status: "pending", queryId: reference.queryId };
  });
  const streamQuery = vi.fn(async () => ({ status: "pending", queryId: reference.queryId }));
  const cancelQuery = vi.fn(async (): Promise<QueryCancellation> => ({
    queryId: reference.queryId,
    cancelled: true,
  }));
  const caller = { submitDetached, pollQuery, streamQuery, cancelQuery };
  const asCaller = vi.fn(() => caller);
  const dependencies: DetachedHttpDependencies = {
    client: { ...caller, asCaller } as unknown as SarClient,
    application: "app",
    mode: "caller",
    authenticate: vi.fn(async () => ({ subject: "subject" })),
    admit: vi.fn(async () => {
      events.push("admit");
    }),
    records: {
      insert: vi.fn(async () => {
        events.push("persist");
      }),
      get: vi.fn(async () => record),
    },
  };
  const request = new Request("https://application.invalid/query");
  return {
    dependencies,
    reference,
    record,
    events,
    submitDetached,
    pollQuery,
    streamQuery,
    cancelQuery,
    asCaller,
    request,
    handlers: detachedHttpHandlers(dependencies),
  };
}

describe("shared-record HTTP example", () => {
  it("persists before returning a query ID without checking even an already completed result", async () => {
    const { handlers, events, request, reference, asCaller, pollQuery } = setup();
    pollQuery.mockResolvedValue({
      status: "complete",
      queryId: reference.queryId,
      result: { rows: [{ USER_NAME: "USER" }] },
    } as never);
    const response = await handlers.submit(request);
    expect(events).toEqual(["admit", "submit", "persist"]);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", queryId: reference.queryId });
    expect(asCaller).toHaveBeenCalledWith({ headers: request.headers });
    expect(pollQuery).not.toHaveBeenCalled();
  });
  it("finishes durable registration after acknowledgement even if the request disconnects", async () => {
    const { handlers, dependencies, reference, pollQuery, cancelQuery } = setup();
    const controller = new AbortController();
    const request = new Request("https://application.invalid/query", { signal: controller.signal });
    const writing = deferred();
    const stored = deferred();
    vi.mocked(dependencies.records.insert).mockImplementation(async () => {
      writing.resolve();
      await stored.promise;
    });
    let responded = false;
    const pending = handlers.submit(request).then((response) => {
      responded = true;
      return response;
    });
    await writing.promise;
    controller.abort();
    expect(responded).toBe(false);
    stored.resolve();
    expect(await (await pending).json()).toEqual({ status: "pending", queryId: reference.queryId });
    expect(pollQuery).not.toHaveBeenCalled();
    expect(cancelQuery).not.toHaveBeenCalled();
  });
  it("checks once per browser request and leaves scheduling to the browser", async () => {
    const { handlers, request, reference, pollQuery } = setup();
    const response = await handlers.poll(request, reference.queryId);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", queryId: reference.queryId });
    expect(pollQuery).toHaveBeenCalledExactlyOnceWith(reference, {
      signal: request.signal,
      decodeRow: expect.any(Function),
    });
  });
  it.each(["subject", "application", "expiry", "mode", "decoder", "queryId"])(
    "rejects unauthorized/expired record %s before Snowflake",
    async (field) => {
      const {
        handlers,
        record,
        request,
        reference,
        pollQuery,
        streamQuery,
        cancelQuery,
        asCaller,
      } = setup();
      const queryId = reference.queryId;
      if (field === "subject") record.subject = "other";
      if (field === "application") record.application = "other";
      if (field === "expiry") record.expiresAt = Date.now() - 1;
      if (field === "mode") record.reference = { ...reference, mode: "owner" };
      if (field === "decoder") record.decoder = "unknown" as never;
      if (field === "queryId") record.reference = { ...reference, queryId: "different" };
      expect((await handlers.poll(request, queryId)).status).toBe(404);
      expect((await handlers.download(request, queryId)).status).toBe(404);
      expect((await handlers.cancel(request, queryId)).status).toBe(404);
      expect(pollQuery).not.toHaveBeenCalled();
      expect(streamQuery).not.toHaveBeenCalled();
      expect(cancelQuery).not.toHaveBeenCalled();
      expect(asCaller).not.toHaveBeenCalled();
    },
  );
  it("rejects missing and unauthenticated records", async () => {
    const { handlers, dependencies, request, reference, pollQuery } = setup();
    vi.mocked(dependencies.records.get).mockResolvedValue(undefined);
    expect((await handlers.poll(request, reference.queryId)).status).toBe(404);
    vi.mocked(dependencies.authenticate).mockRejectedValue(Error("unauthenticated"));
    await expect(handlers.poll(request, reference.queryId)).rejects.toThrow("unauthenticated");
    expect(pollQuery).not.toHaveBeenCalled();
  });
  it("serves a persisted record through a new handler instance", async () => {
    const { handlers, dependencies, request, reference, pollQuery, cancelQuery } = setup();
    await handlers.submit(request);
    pollQuery.mockResolvedValue({
      status: "complete",
      queryId: reference.queryId,
      result: { rows: [{ USER_NAME: "USER" }] },
    } as never);
    const replacement = detachedHttpHandlers(dependencies);
    const response = await replacement.poll(request, reference.queryId);
    expect(response.status).toBe(200);
    expect((await response.json()).result.rows).toEqual([{ USER_NAME: "USER" }]);
    expect((await replacement.cancel(request, reference.queryId)).status).toBe(202);
    expect(cancelQuery).toHaveBeenCalledWith(reference, { signal: request.signal });
  });
  it("cancels explicitly if durable registration fails", async () => {
    const { handlers, dependencies, request, reference, cancelQuery, pollQuery } = setup();
    vi.mocked(dependencies.records.insert).mockRejectedValue(Error("storage unavailable"));
    await expect(handlers.submit(request)).rejects.toThrow("storage unavailable");
    expect(cancelQuery).toHaveBeenCalledWith(reference);
    expect(pollQuery).not.toHaveBeenCalled();
  });
  it("redacts inaccessible queries for HTTP callers", async () => {
    const { handlers, request, reference, pollQuery, cancelQuery } = setup();
    pollQuery.mockRejectedValue(new SarError("QUERY_IDENTITY_MISMATCH", "private"));
    cancelQuery.mockRejectedValue(new SarError("QUERY_UNAVAILABLE", "private"));
    expect(await (await handlers.poll(request, reference.queryId)).json()).toEqual({
      error: "Query unavailable",
    });
    expect((await handlers.cancel(request, reference.queryId)).status).toBe(404);
  });
  it("returns 202 for a pending download and redacts an inaccessible one", async () => {
    const { handlers, request, reference, streamQuery } = setup();
    const pending = await handlers.download(request, reference.queryId);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending", queryId: reference.queryId });
    expect(streamQuery).toHaveBeenCalledExactlyOnceWith(reference, {
      signal: request.signal,
      decodeRow: expect.any(Function),
    });
    streamQuery.mockRejectedValueOnce(new SarError("QUERY_IDENTITY_MISMATCH", "private"));
    const hidden = await handlers.download(request, reference.queryId);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "Query unavailable" });
    const failure = new SarError("TIMEOUT", "Synthetic failure");
    streamQuery.mockRejectedValueOnce(failure);
    await expect(handlers.download(request, reference.queryId)).rejects.toBe(failure);
  });
  it("streams a completed download and closes it when the client disconnects", async () => {
    const { handlers, request, reference, streamQuery } = setup();
    const close = vi.fn(async () => {});
    streamQuery.mockResolvedValue({
      status: "complete",
      queryId: reference.queryId,
      stream: {
        queryId: reference.queryId,
        columns: [],
        close,
        async *[Symbol.asyncIterator]() {
          yield { USER_NAME: "USER" };
          await new Promise(() => {});
        },
      },
    } as never);
    const response = await handlers.download(request, reference.queryId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"USER_NAME":"USER"}\n');
    expect(close).not.toHaveBeenCalled();
    await reader.cancel();
    expect(close).toHaveBeenCalledOnce();
  });
  it("responds with the outcome and never claims a finished query was cancelled", async () => {
    const { handlers, request, reference, cancelQuery } = setup();
    const cancelled = await handlers.cancel(request, reference.queryId);
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({ queryId: reference.queryId, cancelled: true });
    const outcome = { queryId: reference.queryId, cancelled: false, status: "SUCCESS" } as const;
    cancelQuery.mockResolvedValue(outcome);
    const finished = await handlers.cancel(request, reference.queryId);
    expect(finished.status).toBe(409);
    expect(await finished.json()).toEqual(outcome);
    expect(cancelQuery).toHaveBeenCalledTimes(2);
  });
  it("tells the browser when a report finished before it could be cancelled", async () => {
    const service = fakeQueryService();
    const stored = new Map<string, QueryRecord>();
    const client = createSarClient({
      driver: service.driver,
      connectionOptions: {
        getOwnerOptions() {
          return { account: "test", authenticator: "OAUTH", token: "synthetic" };
        },
        getCallerOptions() {
          throw new Error("This fixture uses owner mode");
        },
      },
    });
    const handlers = detachedHttpHandlers({
      client,
      application: "app",
      mode: "owner",
      records: {
        async insert(record) {
          stored.set(record.reference.queryId, record);
        },
        async get(queryId) {
          return stored.get(queryId);
        },
      },
      authenticate: async () => ({ subject: "subject" }),
      admit: async () => {},
    });
    const request = new Request("https://application.invalid/query");
    const { queryId: running } = await (await handlers.submit(request)).json();
    const { queryId: finished } = await (await handlers.submit(request)).json();
    service.queries.get(finished)!.status = "SUCCESS";
    const cancelled = await handlers.cancel(request, running);
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({ queryId: running, cancelled: true });
    const completed = await handlers.cancel(request, finished);
    expect(completed.status).toBe(409);
    expect(await completed.json()).toEqual({
      queryId: finished,
      cancelled: false,
      status: "SUCCESS",
    });
    expect(
      service.connections
        .flatMap((connection) => connection.execute.mock.calls)
        .filter(([options]) => options.sqlText.startsWith("SELECT SYSTEM$CANCEL_QUERY"))
        .map(([options]) => options.binds),
    ).toEqual([[running]]);
    expect(service.queries.get(finished)?.status).toBe("SUCCESS");
    await client.close();
  });
  it.each(["TIMEOUT", "AUTH_FAILED", "QUERY_FAILED"] as const)(
    "propagates %s rather than sending a pending response",
    async (code) => {
      const { handlers, request, reference, pollQuery } = setup();
      const failure = new SarError(code, "Synthetic failure");
      pollQuery.mockRejectedValue(failure);
      await expect(handlers.poll(request, reference.queryId)).rejects.toBe(failure);
      expect(pollQuery).toHaveBeenCalledOnce();
    },
  );
  it("serves client-driven requests after each backend SDK client closes", async () => {
    const service = fakeQueryService();
    service.settings.names = ["USER_NAME"];
    service.settings.types = ["text"];
    service.settings.rows = [["USER"]];
    const stored = new Map<string, QueryRecord>();
    const records = {
      async insert(record: QueryRecord) {
        stored.set(record.reference.queryId, JSON.parse(JSON.stringify(record)));
      },
      async get(queryId: string) {
        return stored.get(queryId);
      },
    };
    function backend() {
      const client = createSarClient({
        driver: service.driver,
        connectionOptions: {
          getOwnerOptions() {
            return { account: "test", authenticator: "OAUTH", token: "synthetic" };
          },
          getCallerOptions() {
            throw new Error("This fixture uses owner mode");
          },
        },
      });
      const handlers = detachedHttpHandlers({
        client,
        application: "app",
        mode: "owner",
        records,
        authenticate: async () => ({ subject: "subject" }),
        admit: async () => {},
      });
      return { client, handlers };
    }

    const request = new Request("https://application.invalid/query");
    const first = backend();
    const submitted = await first.handlers.submit(request);
    expect(submitted.status).toBe(202);
    const { queryId } = await submitted.json();
    expect(service.connections[0]?.getQueryStatus).not.toHaveBeenCalled();
    expect(service.connections[0]?.fetchResult).not.toHaveBeenCalled();
    await first.client.close();

    const second = backend();
    const pending = await second.handlers.poll(request, queryId);
    expect(pending.status).toBe(202);
    expect(service.connections[1]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(service.connections[1]?.fetchResult).not.toHaveBeenCalled();
    await second.client.close();

    service.queries.get(queryId)!.status = "SUCCESS";
    const third = backend();
    const completed = await third.handlers.poll(request, queryId);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      status: "complete",
      queryId,
      result: { rows: [{ USER_NAME: "USER" }], rowCount: 1 },
    });
    expect(service.connections[2]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(service.connections[2]?.fetchResult).toHaveBeenCalledOnce();
    await third.client.close();
    expect(service.queries.size).toBe(1);
    for (const connection of service.connections) {
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(connection.cancel).not.toHaveBeenCalled();
    }
  });
  it("downloads every row through a replacement backend and then releases its connection", async () => {
    const service = fakeQueryService();
    service.settings.names = ["USER_NAME"];
    service.settings.types = ["text"];
    service.settings.rows = [["USER"], ["OTHER"]];
    const stored = new Map<string, QueryRecord>();
    function backend() {
      const client = createSarClient({
        driver: service.driver,
        connectionOptions: {
          getOwnerOptions() {
            return { account: "test", authenticator: "OAUTH", token: "synthetic" };
          },
          getCallerOptions() {
            throw new Error("This fixture uses owner mode");
          },
        },
      });
      const handlers = detachedHttpHandlers({
        client,
        application: "app",
        mode: "owner",
        records: {
          async insert(record) {
            stored.set(record.reference.queryId, JSON.parse(JSON.stringify(record)));
          },
          async get(queryId) {
            return stored.get(queryId);
          },
        },
        authenticate: async () => ({ subject: "subject" }),
        admit: async () => {},
      });
      return { client, handlers };
    }

    const request = new Request("https://application.invalid/query");
    const first = backend();
    const { queryId } = await (await first.handlers.submit(request)).json();
    await first.client.close();
    const second = backend();
    expect((await second.handlers.download(request, queryId)).status).toBe(202);
    await second.client.close();

    service.queries.get(queryId)!.status = "SUCCESS";
    const third = backend();
    const response = await third.handlers.download(request, queryId);
    expect(response.status).toBe(200);
    expect((await third.client.diagnostics()).activeConnections).toBe(1);
    expect(await response.text()).toBe('{"USER_NAME":"USER"}\n{"USER_NAME":"OTHER"}\n');
    await vi.waitFor(async () =>
      expect(await third.client.diagnostics()).toMatchObject({
        activeConnections: 0,
        physicalConnections: 0,
      }),
    );
    await third.client.close();
    for (const connection of service.connections) {
      expect(connection.config.serverSessionKeepAlive).toBe(true);
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(connection.cancel).not.toHaveBeenCalled();
    }
  });
});
