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
import { describe, expect, it, vi } from "vitest";
import type snowflake from "snowflake-sdk";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/auth.js";
import { fakeDriver } from "./fake-driver.js";

function setup(fakeOptions: Parameters<typeof fakeDriver>[0] = {}) {
  const fake = fakeDriver(fakeOptions);
  return {
    ...fake,
    client: createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        accessUrl: "https://test.snowflakecomputing.com",
        authenticator: "OAUTH",
        token: "synthetic",
      }),
    }),
  };
}
const userStatements = (connection: ReturnType<typeof setup>["connections"][number]) =>
  connection.execute.mock.calls
    .map(([options]) => options as snowflake.StatementOption)
    .filter((options) => !options.sqlText.startsWith("ALTER SESSION"));

describe("synchronous query() and stream()", () => {
  it("runs each statement in one driver request, with no status checks or result fetch", async () => {
    const { client, connections } = setup();
    expect((await client.query("SELECT 1")).rowCount).toBe(1);
    for await (const row of await client.stream("SELECT 2")) expect(row).toBeDefined();
    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      const [statement, ...others] = userStatements(connection);
      expect(others).toEqual([]);
      expect(statement).toMatchObject({ streamResult: true, rowMode: "array" });
      expect(statement?.asyncExec).toBeUndefined();
      expect(connection.getQueryStatus).not.toHaveBeenCalled();
      expect(connection.fetchResult).not.toHaveBeenCalled();
    }
    await client.close();
  });
  it("keeps submit() asynchronous so its handle has a query ID right away", async () => {
    const { client, connections } = setup();
    const handle = await client.submit("SELECT 1");
    expect(handle.queryId).toBe("query-1");
    expect(userStatements(connections[0]!)[0]).toMatchObject({ asyncExec: true });
    expect((await handle.result()).rowCount).toBe(1);
    expect(connections[0]?.getQueryStatus).toHaveBeenCalled();
    expect(connections[0]?.fetchResult).toHaveBeenCalledOnce();
    await client.close();
  });
  it("reports a rejected statement's code and keeps its message out of serialized output", async () => {
    const rejected = Object.assign(
      new Error("SQL compilation error: Object 'SECRET_TABLE' does not exist."),
      {
        name: "OperationFailedError",
        code: "002003",
        sqlState: "42S02",
        data: { queryContext: "driver-internal", sqlText: "SELECT * FROM T WHERE SSN = '123'" },
      },
    );
    const { client, connections } = setup({ executeError: rejected });
    const error = await client.query("SELECT * FROM SECRET_TABLE").catch((error) => error);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: "Snowflake query did not succeed (error 002003)",
      details: { queryId: "query-1", completion: "failed", errorCode: "002003", sqlState: "42S02" },
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_TABLE");
    expect(inspect(error)).toContain("Object 'SECRET_TABLE' does not exist.");
    expect(inspect(error)).not.toContain("driver-internal");
    expect(inspect(error)).not.toContain("SSN");
    expect(connections[0]?.cancel).not.toHaveBeenCalled();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("times out a statement that doesn't finish and cancels it", async () => {
    const { client, connections } = setup({ status: "RUNNING" });
    await expect(client.query("SELECT 1", { waitTimeoutMs: 50 })).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { completion: "unknown" },
    });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    expect((await client.diagnostics()).activeConnections).toBe(0);
    await client.close();
  });
  it("cancels a running statement when the caller aborts", async () => {
    const { client, connections } = setup({ status: "RUNNING" });
    const controller = new AbortController();
    const pending = client.stream("SELECT 1", { signal: controller.signal });
    await vi.waitFor(() => expect(userStatements(connections[0]!)).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(connections[0]?.cancel).toHaveBeenCalledOnce();
    await client.close();
  });
  it("reports a driver failure without a Snowflake code as unknown", async () => {
    const { client } = setup({
      fetchError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Query failed; SQL was not replayed",
      details: { queryId: "query-1", completion: "unknown" },
    });
    await client.close();
  });
  it("reports a statement the driver refused to send as not submitted", async () => {
    const fake = fakeDriver();
    const create = fake.driver.createConnection.bind(fake.driver);
    fake.driver.createConnection = (options) => {
      const connection = create(options);
      const execute = connection.execute.bind(connection);
      connection.execute = (statement) => {
        if (statement.sqlText === "SELECT ?") throw new Error("synthetic invalid binds");
        return execute(statement);
      };
      return connection;
    };
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        accessUrl: "https://test.snowflakecomputing.com",
        authenticator: "OAUTH",
        token: "synthetic",
      }),
    });
    await expect(client.query("SELECT ?", { binds: [1] })).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "not-submitted" },
    });
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
});
