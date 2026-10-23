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
import { describe, expect, it } from "vitest";
import type snowflake from "snowflake-sdk";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions, fromCredentials } from "../src/auth.js";
import { dmlCount, isDml } from "../src/results.js";
import type { ColumnMetadata } from "../src/types.js";
import { dmlSummary, fakeDriver } from "./fake-driver.js";
import { fakeQueryService } from "./fake-query-service.js";

function setup(fakeOptions: Parameters<typeof fakeDriver>[0] = {}) {
  const fake = fakeDriver(fakeOptions);
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
function detachedSetup() {
  const service = fakeQueryService();
  service.settings.status = "SUCCESS";
  const options = async () => ({ account: "test", authenticator: "OAUTH", token: "synthetic" });
  return {
    ...service,
    client: createSarClient({
      connectionOptions: { getOwnerOptions: options, getCallerOptions: options },
      driver: service.driver,
    }),
  };
}
function columns(...names: string[]): ColumnMetadata[] {
  return names.map((name, index) => ({
    name,
    type: "fixed",
    index,
    nullable: false,
    precision: 38,
    scale: 0,
  }));
}
const castStep =
  "Cast the column to VARIANT, for example ARRAY_AGG(X)::VARIANT, or use format: 'native'.";
const aliasStep = "Alias the duplicate columns, or use rowMode: 'array'.";
const joinedUpdate = { "number of rows updated": "2", "number of multi-joined rows updated": "1" };

describe("affected rows", () => {
  it.each<{ statement: string; summary: Record<string, string>; count: number }>([
    { statement: "an INSERT", summary: { "number of rows inserted": "3" }, count: 3 },
    { statement: "an UPDATE joining a row to two source rows", summary: joinedUpdate, count: 2 },
    {
      statement: "a multi-table INSERT",
      summary: {
        "number of rows inserted into ORDERS": "2",
        "number of rows inserted into ORDER_AUDIT": "2",
      },
      count: 4,
    },
    {
      statement: "a MERGE",
      summary: { "number of rows inserted": "1", "number of rows updated": "1" },
      count: 2,
    },
    { statement: "a DELETE", summary: { "number of rows deleted": "3" }, count: 3 },
    {
      statement: "an UPDATE matching nothing",
      summary: { "number of rows updated": "0", "number of multi-joined rows updated": "0" },
      count: 0,
    },
  ])("counts the rows changed by $statement", async ({ summary, count }) => {
    const { client } = setup(dmlSummary(summary));
    expect(await client.query("synthetic DML")).toMatchObject({ rowCount: 1, affectedRows: count });
    const handle = await client.submit("synthetic DML");
    expect(await handle.result()).toMatchObject({ rowCount: 1, affectedRows: count });
    await client.close();
  });
  it.each([
    { format: "json" as const, summary: joinedUpdate },
    {
      format: "native" as const,
      summary: { "number of rows updated": 2, "number of multi-joined rows updated": 1 },
    },
  ])("counts $format-format summary values", async ({ format, summary }) => {
    const { client } = setup(dmlSummary(summary));
    const result = await client.query("synthetic DML", { format });
    expect(result).toMatchObject({ rows: [summary], affectedRows: 2 });
    await client.close();
  });
  it("counts the raw summary row, not the decoded row", async () => {
    const { client } = setup(dmlSummary(joinedUpdate));
    const result = await client.query("synthetic DML", {
      decodeRow: () => ({ "number of rows updated": "99" }),
    });
    expect(result).toMatchObject({ rows: [{ "number of rows updated": "99" }], affectedRows: 2 });
    await client.close();
  });
  it.each([
    { summary: joinedUpdate, count: 2 },
    { summary: { "number of rows deleted": "0" }, count: 0 },
  ])("counts $count affected rows in a detached result", async ({ summary, count }) => {
    const { client, settings } = detachedSetup();
    Object.assign(settings, dmlSummary(summary));
    const reference = await client.submitDetached("synthetic DML");
    await expect(client.pollQuery(reference)).resolves.toMatchObject({
      status: "complete",
      result: { rowCount: 1, affectedRows: count },
    });
    await client.close();
  });
  it.each([
    {
      statement: "CREATE TABLE AS SELECT",
      fake: {
        names: ["status"],
        types: ["text"],
        rows: [["Table ITEMS_COPY successfully created."]],
      },
    },
    { statement: "SELECT", fake: { rows: [["1"], ["2"]] } },
    {
      statement: "DML without row-count columns",
      fake: { updatedRows: 1, names: ["status"], types: ["text"], rows: [["1 row changed"]] },
    },
  ])("omits affectedRows for a $statement", async ({ fake }) => {
    const { client } = setup(fake);
    expect(await client.query("synthetic")).not.toHaveProperty("affectedRows");
    await client.close();
  });
  it("omits affectedRows from a detached SELECT", async () => {
    const { client } = detachedSetup();
    const reference = await client.submitDetached("SELECT ID FROM ITEMS");
    const outcome = await client.pollQuery(reference);
    expect(outcome).toHaveProperty("result.rowCount", 1);
    expect(outcome).not.toHaveProperty("result.affectedRows");
    await client.close();
  });
  it("omits affectedRows when the driver statement has no count method", async () => {
    const { client, connections } = setup(dmlSummary({ "number of rows inserted": "1" }));
    const handle = await client.submit("synthetic DML");
    // The fake driver reuses one statement object per connection, including for the fetch.
    const statement = connections[0]!.execute.mock.results.at(-1)!
      .value as Partial<snowflake.RowStatement>;
    delete statement.getNumUpdatedRows;
    const result = await handle.result();
    expect(result.rowCount).toBe(1);
    expect(result).not.toHaveProperty("affectedRows");
    await client.close();
  });
  it.each([
    ["a missing count method", false, {}],
    ["a count of -1", false, { getNumUpdatedRows: () => -1 }],
    ["an undefined count", false, { getNumUpdatedRows: () => undefined }],
    ["a NaN count", false, { getNumUpdatedRows: () => Number.NaN }],
    [
      "a throwing count method",
      false,
      {
        getNumUpdatedRows: () => {
          throw new Error("synthetic driver failure");
        },
      },
    ],
    ["a count of 0", true, { getNumUpdatedRows: () => 0 }],
    ["a positive count", true, { getNumUpdatedRows: () => 3 }],
  ])("treats %s as DML: %s", (_label, expected, statement) => {
    expect(isDml(statement as unknown as snowflake.RowStatement)).toBe(expected);
  });
  it.each([
    ["no row-count column", columns("status"), ["1 row changed"]],
    ["a non-numeric count", columns("number of rows inserted"), ["NULL"]],
    ["a negative count", columns("number of rows deleted"), [-1]],
    ["a fractional count", columns("number of rows updated"), ["1.5"]],
    [
      "an unsafe total",
      columns("number of rows inserted into A", "number of rows inserted into B"),
      [2 ** 52, 2 ** 52],
    ],
    ["a missing row", columns("number of rows inserted"), undefined],
  ])("ignores a summary with %s", (_label, metadata, row) => {
    expect(dmlCount(row, metadata)).toBeUndefined();
  });
  it("matches row-count column names case-insensitively", () => {
    const metadata = columns("NUMBER OF ROWS UPDATED", "NUMBER OF MULTI-JOINED ROWS UPDATED");
    expect(dmlCount(["4", "1"], metadata)).toBe(4);
  });
});

describe("result conversion guidance", () => {
  it.each([
    ["an ARRAY", "array"],
    ["an OBJECT", "object"],
    ["a MAP", "map"],
  ])("names %s column and suggests a VARIANT cast", async (described, type) => {
    const { client } = setup({
      names: ["ID", "TAGS"],
      types: ["fixed", type],
      rows: [["1", '["row-value-12345678901234567890"]']],
    });
    const error = await client
      .query("SELECT ID, TAGS FROM ITEMS WHERE NAME = 'sql-literal'")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      message: `Column 'TAGS' is ${described}, which JSON results can't return exactly. Cast it to VARIANT to receive its JSON text, or use format: 'native'.`,
      details: { queryId: "query-1", completion: "succeeded", nextStep: castStep },
    });
    for (const text of [JSON.stringify(error), inspect(error)]) {
      expect(text).not.toContain("row-value");
      expect(text).not.toContain("sql-literal");
    }
    await client.close();
  });
  it("annotates conversion guidance on streams and detached results", async () => {
    const { client } = setup({ names: ["TAGS"], types: ["array"] });
    await expect(client.stream("SELECT TAGS FROM ITEMS")).rejects.toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      details: { queryId: "query-1", completion: "succeeded", nextStep: castStep },
    });
    await client.close();
    const detached = detachedSetup();
    detached.settings.names = ["TAGS"];
    detached.settings.types = ["array"];
    const reference = await detached.client.submitDetached("SELECT TAGS FROM ITEMS");
    await expect(detached.client.pollQuery(reference)).rejects.toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      message: expect.stringContaining("Column 'TAGS' is an ARRAY"),
      details: { queryId: reference.queryId, completion: "succeeded", nextStep: castStep },
    });
    await detached.client.close();
  });
  it("returns the suggested VARIANT cast as exact JSON text", async () => {
    const json = "[12345678901234567890]";
    const { client } = setup({ names: ["TAGS"], types: ["variant"], rows: [[json]] });
    expect((await client.query("SELECT ARRAY_AGG(TAG)::VARIANT AS TAGS FROM ITEMS")).rows).toEqual([
      { TAGS: json },
    ]);
    await client.close();
  });
  it("still returns OBJECT columns in native format", async () => {
    const { client } = setup({ names: ["ATTRIBUTES"], types: ["object"], rows: [[{ size: 1 }]] });
    const result = await client.query("SELECT ATTRIBUTES FROM ITEMS", { format: "native" });
    expect(result.rows).toEqual([{ ATTRIBUTES: { size: 1 } }]);
    await client.close();
  });
});

describe("duplicate column guidance", () => {
  it("names the first repeated column and still permits array rows", async () => {
    const { client } = setup({
      names: ["ID", "NAME", "NAME", "ID"],
      rows: [["1", "item", "tag", "2"]],
    });
    const sql = "SELECT I.ID, I.NAME, T.NAME, T.ID FROM ITEMS I JOIN TAGS T ON T.ITEM_ID = I.ID";
    await expect(client.query(sql)).rejects.toMatchObject({
      code: "DUPLICATE_COLUMNS",
      message: `Column 'NAME' repeats an earlier column name. ${aliasStep}`,
      details: { queryId: "query-1", completion: "succeeded", nextStep: aliasStep },
    });
    expect((await client.query(sql, { rowMode: "array" })).rows).toEqual([
      ["1", "item", "tag", "2"],
    ]);
    await client.close();
  });
});

describe("column references in errors", () => {
  const ssn = "123-45-6789";
  async function failure(fakeOptions: Parameters<typeof fakeDriver>[0]) {
    const { client } = setup(fakeOptions);
    const error = await client.query("synthetic").catch((error: unknown) => error);
    await client.close();
    for (const text of [(error as Error).message, JSON.stringify(error), inspect(error)])
      expect(text).not.toContain(ssn);
    return error;
  }
  it("refers to a container expression column by position", async () => {
    const error = await failure({
      names: ["ID", `OBJECT_CONSTRUCT('ssn', '${ssn}')`],
      types: ["fixed", "object"],
      rows: [["1", "{}"]],
    });
    expect(error).toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      message:
        "Column 2 is an OBJECT, which JSON results can't return exactly. Cast it to VARIANT to receive its JSON text, or use format: 'native'.",
      details: { nextStep: castStep },
    });
  });
  it("refers to a repeated expression column by position", async () => {
    const name = `'${ssn}'`;
    const error = await failure({ names: ["ID", name, name], rows: [["1", ssn, ssn]] });
    expect(error).toMatchObject({
      code: "DUPLICATE_COLUMNS",
      message: `Column 3 repeats an earlier column name. ${aliasStep}`,
      details: { nextStep: aliasStep },
    });
  });
  it.each([
    { kind: "a plain identifier", name: "CREATED_AT", label: "column 'CREATED_AT'" },
    { kind: "an expression", name: `IFF(SSN = '${ssn}', CREATED_AT, NULL)`, label: "column 1" },
  ])("labels an unconvertible column named by $kind as $label", async ({ name, label }) => {
    const error = await failure({ names: [name], types: ["timestamp_ntz"], rows: [[new Date(0)]] });
    expect(error).toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      message: `Driver did not preserve a JSON-safe representation for ${label}. Use format: 'native' explicitly.`,
    });
  });
});
