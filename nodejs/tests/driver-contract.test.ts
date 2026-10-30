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

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/connection-options/index.js";
import { convertRow, metadata } from "../src/query-client/results.js";
import { fakeDriver } from "./fake-driver.js";
import snowflake from "snowflake-sdk";

const load = createRequire(path.join(process.cwd(), "package.json"));
// Private driver imports are confined to pinned-version characterization tests.
const Column = load(
  path.join(path.dirname(load.resolve("snowflake-sdk")), "lib/connection/result/column.js"),
);
function clientFor(options: Parameters<typeof fakeDriver>[0] = {}) {
  const fake = fakeDriver(options);
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

describe("pinned driver compatibility", () => {
  it.each([
    "fixed",
    "real",
    "date",
    "time",
    "timestamp_ntz",
    "timestamp_ltz",
    "timestamp_tz",
    "variant",
    "text",
  ])("preserves SQL NULL in %s without changing driver globals", (type) => {
    const column = new Column({
      columnMetadata: { name: "VALUE", type, nullable: true, scale: 0, precision: 38 },
      index: 0,
      statementParameters: {},
      resultVersion: 1,
    });
    const raw = { values: [null], _arrayProcessedColumns: [] };
    const value = type === "text" ? column._getRowValue(raw) : column._getRowValueAsString(raw);
    const columns = [{ name: "VALUE", type, index: 0, nullable: true, scale: 0, precision: 38 }];
    expect(convertRow([value], columns, {})).toEqual({ VALUE: null });
    expect(convertRow([value], columns, { format: "native" })).toEqual({ VALUE: value });
  });
  it.each([
    ["text", "NULL"],
    ["variant", '"NULL"'],
    ["variant", "null"],
  ])("preserves %s literal %s", (type, value) => {
    expect(
      convertRow(
        [value],
        [{ name: "VALUE", type: type!, index: 0, nullable: true, scale: null, precision: null }],
        {},
      ),
    ).toEqual({ VALUE: value });
  });
  it("rejects asynchronous decoders without unhandled rejections", () => {
    expect(() =>
      convertRow([], [], {
        decodeRow: async () => {
          throw Error("private");
        },
      }),
    ).toThrow("synchronous");
  });
  it("rejects unstructured container columns before row parsing", () => {
    const statement = {
      getColumns: () => [{ getName: () => "DATA", getType: () => "object" }],
    } as unknown as snowflake.RowStatement;
    expect(() => metadata(statement, {})).toThrow("Column 'DATA' is an OBJECT");
  });
  it("does not invoke a raw callback on failed login", async () => {
    const { client, connections } = clientFor({ connectError: Error("private cause") });
    const callback = vi.fn();
    await expect(client.withConnection(callback)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(callback).not.toHaveBeenCalled();
    // The driver's pool drops a connection that failed to log in; it has no session to log out.
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    expect((await client.diagnostics()).physicalConnections).toBe(0);
    await client.close();
  });
  it("builds pooled connections from the shared options as they are at acquire time", () => {
    const options: Record<string, unknown> = {
      account: "synthetic",
      accessUrl: "https://synthetic.invalid",
      authenticator: "OAUTH",
      token: "synthetic",
    };
    const pool = snowflake.createPool(options as snowflake.ConnectionOptions, { max: 1, min: 0 });
    for (const key of Object.keys(options)) delete options[key];
    options.token = 42;
    // The construction error escapes acquire() and leaves its request in the pool, unsettled.
    expect(() => pool.acquire()).toThrow();
    expect(pool.pending).toBe(1);
  });
  it("waits through BLOCKED and unknown statuses", async () => {
    const { client } = clientFor({ statuses: ["BLOCKED", "FUTURE_STATUS", "SUCCESS"] });
    expect((await client.query("synthetic", { pollIntervalMs: 1 })).rowCount).toBe(1);
    await client.close();
  });
  it("keeps successful server status after a local result limit failure", async () => {
    const { client } = clientFor({ rows: [["1"], ["2"]] });
    const handle = await client.submit("synthetic", { maxRows: 1 });
    await expect(handle.result()).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: { completion: "succeeded" },
    });
    expect(await handle.status()).toBe("SUCCESS");
    await client.close();
  });
});
