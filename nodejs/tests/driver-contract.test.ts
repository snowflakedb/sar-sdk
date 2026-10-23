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
import { createConnectionOptions, fromCredentials } from "../src/auth.js";
import { connect } from "../src/driver-adapter.js";
import { convertRow, metadata } from "../src/results.js";
import { fakeDriver } from "./fake-driver.js";
import type snowflake from "snowflake-sdk";

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
      connectionOptions: createConnectionOptions(
        [
          fromCredentials({
            target: { account: "test" },
            credential: { type: "oauth", token: "synthetic" },
          }),
        ],
        { environment: "local" },
      ),
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
  it("uses callback success rather than connectAsync fulfillment", async () => {
    const error = Error("synthetic login failure");
    const connection = {
      connect: (callback: (error: Error) => void) => callback(error),
      connectAsync: vi.fn(async () => undefined),
    } as unknown as snowflake.Connection;
    await expect(connect(connection)).rejects.toBe(error);
    expect(connection.connectAsync).not.toHaveBeenCalled();
  });
  it("does not invoke a raw callback on failed login", async () => {
    const { client, connections } = clientFor({ connectError: Error("private cause") });
    const callback = vi.fn();
    await expect(client.withConnection(callback)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(callback).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(connections[0]?.destroy).toHaveBeenCalledOnce());
    await client.close();
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
