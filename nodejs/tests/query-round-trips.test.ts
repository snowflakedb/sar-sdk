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
import type snowflake from "snowflake-sdk";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions, fromCredentials } from "../src/auth.js";
import { fakeDriver } from "./fake-driver.js";
import type { SarClientOptions } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  fakeOptions: Parameters<typeof fakeDriver>[0] = {},
  options: Pick<SarClientOptions, "pool" | "timeouts" | "results"> = {},
) {
  const fake = fakeDriver(fakeOptions);
  return {
    ...fake,
    client: createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions([
        fromCredentials({
          target: { account: "test" },
          credential: { type: "oauth", token: "synthetic" },
        }),
      ]),
      ...options,
    }),
  };
}
const settles = async (promise: Promise<unknown>) => {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return settled;
};

describe("result fetch", () => {
  it("fetches a successful handle result without checking its status again", async () => {
    const { client, connections } = setup();
    await (await client.submit("SELECT 1")).result();
    expect(connections[0]?.getQueryStatus).toHaveBeenCalledOnce();
    expect(connections[0]?.fetchResult).toHaveBeenCalledOnce();
    expect(connections[0]?.fetchResult.mock.calls[0]?.[0]).toMatchObject({
      queryId: "query-1",
      rowMode: "array",
      fetchAsString: ["Number", "Date", "JSON"],
    });
    await client.close();
  });
  it("fetches only after the status check reports success", async () => {
    const { client, connections } = setup({ statuses: ["RUNNING", "QUEUED", "SUCCESS"] });
    const handle = await client.submit("SELECT 1", { pollIntervalMs: 1 });
    expect((await handle.result()).rowCount).toBe(1);
    const checks = connections[0]!.getQueryStatus.mock.invocationCallOrder;
    const fetches = connections[0]!.fetchResult.mock.invocationCallOrder;
    expect(checks).toHaveLength(3);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toBeGreaterThan(checks[2]!);
    await client.close();
  });
  it("rejects a fetched result that belongs to another query", async () => {
    const fake = fakeDriver();
    const create = fake.driver.createConnection.bind(fake.driver);
    fake.driver.createConnection = (options) => {
      const connection = create(options);
      connection.fetchResult = (execution) => {
        const other = { getQueryId: () => "query-other" } as unknown as snowflake.RowStatement;
        queueMicrotask(() => execution.complete?.(undefined, other, undefined));
        return other;
      };
      return connection;
    };
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions([
        fromCredentials({
          target: { account: "test" },
          credential: { type: "oauth", token: "synthetic" },
        }),
      ]),
    });
    await expect((await client.submit("SELECT 1")).result()).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Result lookup returned a different query ID",
      details: { queryId: "query-1", completion: "succeeded" },
    });
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
});

describe("session release after every row is read", () => {
  it("returns query rows while the session is still logging out", async () => {
    const logout = deferred();
    const { client, connections } = setup({ destroyGate: logout.promise });
    const result = await client.query("SELECT 1");
    expect(result.rows).toEqual([{ VALUE: "9007199254740993" }]);
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    expect(await client.diagnostics()).toMatchObject({
      activeConnections: 1,
      physicalConnections: 1,
    });
    logout.resolve();
    await vi.waitFor(async () =>
      expect(await client.diagnostics()).toMatchObject({
        activeConnections: 0,
        physicalConnections: 0,
      }),
    );
    await client.close();
  });
  it("ends stream iteration while the session is still logging out", async () => {
    const logout = deferred();
    const { client, connections } = setup({ destroyGate: logout.promise, rows: [["1"], ["2"]] });
    const stream = await client.stream("SELECT 1");
    const rows: unknown[] = [];
    for await (const row of stream) rows.push(row);
    expect(rows).toEqual([{ VALUE: "1" }, { VALUE: "2" }]);
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    const closing = stream.close();
    expect(await settles(closing)).toBe(false);
    logout.resolve();
    await closing;
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("makes client shutdown wait for a logout still in progress", async () => {
    const logout = deferred();
    const { client, connections } = setup({ destroyGate: logout.promise });
    await client.query("SELECT 1");
    const closing = client.close();
    expect(await settles(closing)).toBe(false);
    logout.resolve();
    await closing;
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).physicalConnections).toBe(0);
  });
  it("still reports a logout that outlasts the shutdown grace period", async () => {
    const logout = deferred();
    const { client } = setup({ destroyGate: logout.promise });
    await client.query("SELECT 1");
    const closing = client.close({ timeoutMs: 1 });
    const rejected = expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(await settles(closing)).toBe(false);
    logout.resolve();
    await rejected;
  });
  it("keeps rows that were read when the logout fails", async () => {
    const { client } = setup({ destroyError: Error("synthetic-logout-failure") });
    const result = await client.query("SELECT 1");
    expect(result.rowCount).toBe(1);
    const handle = await client.submit("SELECT 2");
    expect((await handle.result()).rowCount).toBe(1);
    await vi.waitFor(async () =>
      expect(await client.diagnostics()).toMatchObject({
        activeConnections: 0,
        physicalConnections: 0,
      }),
    );
    await client.close();
  });
  it("finishes a reusable session's reset before returning so the next query reuses it", async () => {
    const resetting = deferred();
    const reset = vi.fn(() => resetting.promise);
    const { client, connections } = setup({}, { pool: { mode: "reusable", reset } });
    const first = client.query("SELECT 1");
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(await settles(first)).toBe(false);
    resetting.resolve();
    expect((await first).rowCount).toBe(1);
    await client.query("SELECT 2");
    expect(connections).toHaveLength(1);
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    await client.close();
  });
});
