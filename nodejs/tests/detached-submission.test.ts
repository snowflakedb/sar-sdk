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
import { createConnectionManager } from "../src/connections.js";
import { createConnectionOptions, fromCredentials } from "../src/auth.js";
import { detachedInternals } from "../src/lease.js";
import { submitDetached } from "../src/detached.js";
import { deferred, fakeQueryService } from "./fake-query-service.js";
import type { DetachedQueryOptions } from "../src/types.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const fake = fakeQueryService();
  const provider = createConnectionOptions(
    fromCredentials({
      target: { account: "test" },
      credential: { type: "oauth", token: "synthetic" },
    }),
    { environment: "local" },
  );
  const reset = vi.fn(async () => {});
  const manager = createConnectionManager(provider, {
    driver: fake.driver,
    pool: { maxConnections: 1, mode: "reusable", reset },
  });
  const internals = detachedInternals(manager);
  return {
    ...fake,
    manager,
    reset,
    submit: (options?: DetachedQueryOptions) =>
      submitDetached("synthetic", options, undefined, internals.mode, internals.acquire),
  };
}

describe("detached submission lifecycle", () => {
  it("acknowledges once, preserves server work, and releases physical capacity", async () => {
    const { submit, manager, connections, queries, reset } = setup();
    const reference = await submit({ binds: ["private"], maxRows: 3 });
    expect(reference).toMatchObject({
      mode: "owner",
      identity: { organization: "ORG", user: "USER" },
      results: { maxRows: 3 },
    });
    expect(JSON.stringify(reference)).not.toMatch(/synthetic|private|token|session/i);
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
    expect(connections[0]?.config).toMatchObject({
      serverSessionKeepAlive: true,
      clientSessionKeepAlive: false,
    });
    expect(
      connections[0]?.execute.mock.calls.filter(([options]) => options.asyncExec),
    ).toHaveLength(1);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect(connections[0]?.getQueryStatus).not.toHaveBeenCalled();
    expect(connections[0]?.fetchResult).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(await manager.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 0,
      idleConnections: 0,
    });
    await manager.close();
    expect(queries.get(reference.queryId)?.status).toBe("RUNNING");
  });
  it("neither borrows nor returns reusable sessions", async () => {
    const { submit, manager, connections, reset } = setup();
    await manager.withConnection(async () => {});
    await submit();
    await manager.withConnection(async () => {});
    expect(connections.map((connection) => connection.config.serverSessionKeepAlive)).toEqual([
      false,
      true,
      false,
    ]);
    expect(reset).toHaveBeenCalledTimes(2);
    await manager.close();
  });
  it.each(["true", "invalid"])(
    "rejects detached-query policy %s before user SQL",
    async (policy) => {
      const { submit, manager, connections, settings } = setup();
      settings.abortDetached = policy;
      await expect(submit()).rejects.toMatchObject({
        code: "DETACHED_QUERY_NOT_SUPPORTED",
        details: { completion: "not-submitted" },
      });
      expect(connections[0]?.execute.mock.calls.some(([options]) => options.asyncExec)).toBe(false);
      await manager.close();
    },
  );
  it.each([
    ["15", 600_000, 15],
    ["0", 1999, 1],
    ["172800", 600_000, 600],
  ])(
    "does not increase the effective statement limit %s",
    async (existing, requested, expected) => {
      const { submit, manager, settings, connections } = setup();
      settings.statementTimeout = existing;
      await submit({ executionTimeoutMs: requested, format: "native" });
      expect(
        connections[0]?.execute.mock.calls.some(
          ([options]) =>
            options.sqlText === `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${expected}`,
        ),
      ).toBe(true);
      await manager.close();
    },
  );
  it("fails closed on autocommit, unknown parameters, and invalid identity", async () => {
    const { submit, manager, settings } = setup();
    settings.autocommit = "false";
    await expect(submit()).rejects.toMatchObject({ code: "DETACHED_QUERY_NOT_SUPPORTED" });
    settings.autocommit = "true";
    settings.missingParameter = true;
    await expect(submit()).rejects.toMatchObject({ code: "DETACHED_QUERY_NOT_SUPPORTED" });
    settings.missingParameter = false;
    settings.statementTimeout = "unknown";
    await expect(submit()).rejects.toMatchObject({ code: "DETACHED_QUERY_NOT_SUPPORTED" });
    settings.identityRows = [];
    await expect(submit()).rejects.toMatchObject({ code: "QUERY_IDENTITY_MISMATCH" });
    settings.identityRows = [{}];
    await expect(submit()).rejects.toMatchObject({ code: "QUERY_IDENTITY_MISMATCH" });
    await manager.close();
  });
  it("does not cancel when the request aborts immediately after acknowledgement", async () => {
    const { submit, manager, settings, connections, queries } = setup();
    const controller = new AbortController();
    settings.onAcknowledged = () => controller.abort();
    await expect(submit({ signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
      details: { queryId: expect.any(String), completion: "unknown" },
    });
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect([...queries.values()][0]?.status).toBe("RUNNING");
    await manager.close();
  });
  it("keeps an acknowledged query alive during forced shutdown", async () => {
    vi.useFakeTimers();
    const { submit, manager, settings, connections, queries } = setup();
    const gate = deferred();
    settings.destroyGate = gate.promise;
    const submission = submit();
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    const closing = manager.close({ timeoutMs: 1 });
    const rejected = expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(2);
    gate.resolve();
    await submission;
    await rejected;
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect([...queries.values()][0]?.status).toBe("RUNNING");
  });
  it("handles late acknowledgement after timeout without replay", async () => {
    vi.useFakeTimers();
    const { submit, manager, settings, connections } = setup();
    const gate = deferred();
    settings.submitGate = gate.promise;
    const pending = submit({ submitTimeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "unknown" },
    });
    await vi.waitFor(() =>
      expect(connections[0]?.execute.mock.calls.some(([options]) => options.asyncExec)).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      connections[0]?.execute.mock.calls.filter(([options]) => options.asyncExec),
    ).toHaveLength(1);
    expect((await manager.diagnostics()).physicalConnections).toBe(0);
    await manager.close();
  });
  it("rejects missing caller context and incompatible scopes", async () => {
    const { manager } = setup();
    expect(() => detachedInternals(manager.asCaller({ headers: new Headers() }))).toThrow(
      /caller credentials/,
    );
    const oldScope = { withConnection: async () => {} };
    Object.defineProperty(oldScope, Symbol.for("@snowflake/sar-sdk/connection-scope/v1"), {
      value: { acquire() {}, handleIdleTimeoutMs: 100 },
    });
    expect(() => detachedInternals(oldScope as never)).toThrow(/does not support/);
    await manager.close();
  });
});

describe("detached submission failure boundaries", () => {
  it("does not claim non-submission when execute throws synchronously", async () => {
    const { submit, manager, settings, connections } = setup();
    settings.executeThrows = true;
    await expect(submit()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "unknown" },
    });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("does not submit after an aborted or timed-out login, including late connections", async () => {
    vi.useFakeTimers();
    const { submit, manager, settings, connections } = setup();
    const gate = deferred();
    settings.connectGate = gate.promise;
    const pending = submit({ authTimeoutMs: 100 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.waitFor(() => expect(connections[0]?.connect).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    gate.resolve();
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    expect(connections[0]?.execute).not.toHaveBeenCalled();
    await expect(submit({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(connections).toHaveLength(1);
    await manager.close();
  });
  it("preserves submission failure when best-effort cancellation also fails", async () => {
    const { submit, manager, settings, connections } = setup();
    settings.submitError = Error("private submission error");
    settings.cancelError = Error("private cancellation error");
    await expect(submit()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Detached submission failed; SQL was not replayed",
      details: { completion: "unknown" },
    });
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("releases setup failures without executing user SQL", async () => {
    const { submit, manager, settings, connections } = setup();
    settings.controlError = Error("private setup failure");
    await expect(submit()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "not-submitted" },
    });
    expect(connections[0]?.execute.mock.calls).toHaveLength(1);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it.each(["missingQueryId", "acknowledgementIdError"] as const)(
    "handles a bad acknowledgement: %s",
    async (flag) => {
      const { submit, manager, settings, connections } = setup();
      settings[flag] = true;
      await expect(submit()).rejects.toBeInstanceOf(Error);
      expect(connections[0]?.cancel).not.toHaveBeenCalled();
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
      await manager.close();
    },
  );
  it("retains physical permits while local destruction exceeds its timeout", async () => {
    vi.useFakeTimers();
    const { submit, manager, settings, connections } = setup();
    const gate = deferred();
    settings.destroyGate = gate.promise;
    const pending = submit();
    const failed = expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { queryId: expect.any(String) },
    });
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5001);
    await failed;
    expect(await manager.diagnostics()).toMatchObject({
      activeConnections: 0,
      physicalConnections: 1,
    });
    const next = submit({ authTimeoutMs: 100 });
    const timedOut = expect(next).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.waitFor(() =>
      expect(manager.diagnostics()).resolves.toMatchObject({ activeConnections: 1 }),
    );
    await vi.advanceTimersByTimeAsync(150);
    await timedOut;
    expect(connections).toHaveLength(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect((await manager.diagnostics()).physicalConnections).toBe(0);
    await manager.close();
  });
});
