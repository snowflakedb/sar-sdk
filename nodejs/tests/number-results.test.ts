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
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/auth.js";
import { createConnectionManager } from "../src/connections.js";
import { queryReference } from "../src/detached-options.js";
import type { SarError } from "../src/errors.js";
import { createQueryClient } from "../src/queries.js";
import { convertRow } from "../src/results.js";
import { fakeDriver } from "./fake-driver.js";
import { fakeQueryService } from "./fake-query-service.js";
import type { ColumnMetadata, QueryOptions, QueryReference, ResultOptions } from "../src/types.js";

// Value shapes follow what the pinned driver passes through in JSON format: NUMBER as positional
// text padded to its scale, FLOAT as the server's rounded text, which can use an exponent.

function provider() {
  return createConnectionOptions({
    account: "test",
    accessUrl: "https://test.snowflakecomputing.com",
    authenticator: "OAUTH",
    token: "synthetic",
  });
}
function setup(fake: Parameters<typeof fakeDriver>[0] = {}, results?: ResultOptions) {
  const driver = fakeDriver(fake);
  return {
    ...driver,
    client: createSarClient({ driver: driver.driver, connectionOptions: provider(), results }),
  };
}
function detachedSetup() {
  const service = fakeQueryService();
  const options = () => ({ account: "test", authenticator: "OAUTH", token: "synthetic" });
  const connectionOptions = { getOwnerOptions: options, getCallerOptions: options };
  return {
    ...service,
    create: (results?: ResultOptions) =>
      createSarClient({ connectionOptions, driver: service.driver, results }),
  };
}
function column(type: string, name = "VALUE", index = 0): ColumnMetadata {
  return { name, type, index, nullable: true, precision: 38, scale: 0 };
}
function convert(value: unknown, type: string, options: QueryOptions = { numbers: "number" }) {
  return (convertRow([value], [column(type)], options) as Record<string, unknown>).VALUE;
}
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
}
function summary(error: unknown) {
  const { code, message, details } = error as SarError;
  return { code, message, details };
}
/** The expected error; label is the quoted column name or its 1-based position. */
function inexact(label: string, queryId?: string) {
  const nextStep = "Use numbers: 'string', or cast the column to VARCHAR.";
  return {
    code: "RESULT_CONVERSION_UNSUPPORTED",
    message: `Column ${label} has a value that can't be returned as an exact, finite JavaScript number. ${nextStep}`,
    details: { completion: "succeeded", nextStep, ...(queryId ? { queryId } : {}) },
  };
}
const defaults = {
  format: "json",
  rowMode: "object",
  maxRows: 100_000,
  maxBytes: 32 * 1024 * 1024,
} as const;

describe("exact number conversion", () => {
  it.each([
    ["42", 42],
    ["-7", -7],
    ["9007199254740991", 9007199254740991],
    ["-9007199254740991", -9007199254740991],
    ["12.34", 12.34],
    ["12.50", 12.5],
    ["-0.50", -0.5],
    ["0.000001", 0.000001],
    ["0.0000001", 1e-7],
    ["0.0000001000", 1e-7],
    ["0.000", 0],
    ["42.00", 42],
    ["+007.250", 7.25],
    ["-0", 0],
    ["-0.00", 0],
  ])("converts NUMBER %j to %s", (value, expected) => {
    expect(convert(value, "fixed")).toBe(expected);
  });
  it("converts driver bigints with the same safe-integer rule", () => {
    expect(convert(42n, "fixed")).toBe(42);
    expect(thrown(() => convert(2n ** 53n, "fixed"))).toMatchObject(inexact("'VALUE'"));
  });
  it.each([
    "9007199254740992",
    "9007199254740993",
    "-9007199254740993",
    "9007199254740992.0",
    "12345678901234567890",
    "123456789012345678901234567890",
    "0.1000000000000000055511151231257827",
    "1.00000000000000011",
    "0.00000012345678901234567",
    "",
    " 1",
    "1e5",
    "Infinity",
  ])("rejects NUMBER %j instead of rounding it", (value) => {
    expect(thrown(() => convert(value, "fixed"))).toMatchObject(inexact("'VALUE'"));
  });
  it.each([
    ["0.1", 0.1],
    ["0.3", 0.3],
    ["1e-07", 1e-7],
    ["2.5e-08", 2.5e-8],
    ["1e+21", 1e21],
    ["4.940656458e-324", 5e-324],
    ["-0", -0],
  ])("converts FLOAT text %j", (value, expected) => {
    expect(convert(value, "real")).toBe(expected);
  });
  it.each(["NaN", "inf", "-inf", "1.79769313486232e+308", "", "0x10"])(
    "rejects FLOAT text %j that isn't a finite number",
    (value) => {
      expect(thrown(() => convert(value, "real"))).toMatchObject(inexact("'VALUE'"));
    },
  );
  it.each([1.5, -2.5e-10, 1e300])("returns a finite FLOAT driver number %s as is", (value) => {
    expect(convert(value, "real")).toBe(value);
  });
  it.each([
    ["real", Infinity],
    ["real", -Infinity],
    ["real", NaN],
    ["fixed", 42],
  ] as const)("keeps the existing error for a %s driver number %s", (type, value) => {
    const existing = thrown(() => convert(value, type, {}));
    expect(existing).toMatchObject({
      code: "RESULT_CONVERSION_UNSUPPORTED",
      details: { completion: "succeeded" },
    });
    expect(summary(thrown(() => convert(value, type)))).toEqual(summary(existing));
  });
  it.each(["fixed", "real"])("returns typed SQL NULL in %s as null", (type) => {
    expect(convert("NULL", type)).toBeNull();
    expect(convert(null, type)).toBeNull();
  });
  it("leaves other column types unchanged", () => {
    const columns = [
      column("text", "NAME", 0),
      column("text", "NOTE", 1),
      column("date", "DAY", 2),
      column("timestamp_tz", "AT", 3),
      column("variant", "DATA", 4),
      column("binary", "BYTES", 5),
      column("boolean", "FLAG", 6),
    ];
    const row = [
      "42",
      "NULL",
      "2026-01-01",
      "2026-01-01T00:00:00.123456789+00:00",
      "42",
      Buffer.from("hello"),
      true,
    ];
    expect(convertRow(row, columns, { numbers: "number" })).toEqual({
      NAME: "42",
      NOTE: "NULL",
      DAY: "2026-01-01",
      AT: "2026-01-01T00:00:00.123456789+00:00",
      DATA: "42",
      BYTES: "aGVsbG8=",
      FLAG: true,
    });
  });
  it("keeps strings by default and with numbers: 'string'", () => {
    for (const options of [{}, { numbers: "string" }] as const) {
      expect(convert("42", "fixed", options)).toBe("42");
      expect(convert("0.0000001000", "fixed", options)).toBe("0.0000001000");
      expect(convert("9007199254740993", "fixed", options)).toBe("9007199254740993");
      expect(convert("1e-07", "real", options)).toBe("1e-07");
      expect(convert("NaN", "real", options)).toBe("NaN");
      expect(convert(1.5, "real", options)).toBe("1.5");
    }
  });
  it("converts array rows before decodeRow runs", () => {
    const columns = [column("fixed", "ID"), column("real", "PRICE", 1), column("text", "CODE", 2)];
    const decodeRow = vi.fn((row: unknown) => row);
    expect(
      convertRow(["7", "2.5e-08", "7"], columns, {
        numbers: "number",
        rowMode: "array",
        decodeRow,
      }),
    ).toEqual([7, 2.5e-8, "7"]);
    expect(decodeRow).toHaveBeenCalledExactlyOnceWith([7, 2.5e-8, "7"]);
  });
  it.each([
    ["ID", "'ID'"],
    ["order_total$2", "'order_total$2'"],
    ["_RAW", "'_RAW'"],
    ["12345678901234567890", "1"],
    ["SUM(AMOUNT)", "1"],
    ["order total", "1"],
    ["", "1"],
  ])("labels column %j as %s in conversion errors", (name, label) => {
    const columns = [column("fixed", name)];
    expect(
      thrown(() => convertRow(["9007199254740993"], columns, { numbers: "number" })),
    ).toMatchObject(inexact(label));
  });
});

describe("numbers result setting", () => {
  it("applies a client default that a query can override", async () => {
    const { client } = setup(
      { names: ["TOTAL", "RATIO"], types: ["fixed", "real"], rows: [["42", "2.5e-08"]] },
      { numbers: "number" },
    );
    const decodeRow = vi.fn((row: unknown) => row);
    expect((await client.query("SELECT 1", { decodeRow })).rows).toEqual([
      { TOTAL: 42, RATIO: 2.5e-8 },
    ]);
    expect(decodeRow).toHaveBeenCalledExactlyOnceWith({ TOTAL: 42, RATIO: 2.5e-8 });
    expect((await client.query("SELECT 1", { numbers: undefined, rowMode: "array" })).rows).toEqual(
      [[42, 2.5e-8]],
    );
    expect((await client.query("SELECT 1", { numbers: "string" })).rows).toEqual([
      { TOTAL: "42", RATIO: "2.5e-08" },
    ]);
    await client.close();
  });
  it("applies the client default to transaction statements, which can override it", async () => {
    const { client } = setup({ rows: [["12.50"]] }, { numbers: "number" });
    const rows = await client.transaction(async (tx) => [
      (await tx.query("SELECT 1")).rows,
      (await tx.query("SELECT 2", { numbers: "string" })).rows,
    ]);
    expect(rows).toEqual([[{ VALUE: 12.5 }], [{ VALUE: "12.50" }]]);
    await client.close();
  });
  it("applies a query client default", async () => {
    const fake = fakeDriver({ rows: [["12.50"]] });
    const manager = createConnectionManager(provider(), { driver: fake.driver });
    const queries = createQueryClient(manager, { results: { numbers: "number" } });
    expect((await queries.query("SELECT 1")).rows).toEqual([{ VALUE: 12.5 }]);
    await queries.close();
    await manager.close();
  });
  it("converts streamed rows and stops at an inexact value", async () => {
    const { client, connections } = setup({ names: ["ID"], rows: [["1"], ["9007199254740993"]] });
    const stream = await client.stream("SELECT ID", { numbers: "number" });
    const rows: unknown[] = [];
    const consumed = (async () => {
      for await (const row of stream) rows.push(row);
    })();
    await expect(consumed).rejects.toMatchObject(inexact("'ID'", "query-1"));
    expect(rows).toEqual([{ ID: 1 }]);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await client.close();
  });
  it("converts handle results", async () => {
    const { client } = setup({ names: ["ID"], rows: [["9007199254740991"], ["0.0000001000"]] });
    const handle = await client.submit("SELECT ID", { numbers: "number" });
    expect((await handle.result()).rows).toEqual([{ ID: 9007199254740991 }, { ID: 1e-7 }]);
    await client.close();
  });
  it.each([
    ["fixed", "9007199254740993"],
    ["fixed", "0.1000000000000000055511151231257827"],
    ["real", "1.79769313486232e+308"],
  ])("fails a handle result for %s %s without revealing the value", async (type, value) => {
    const { client } = setup({ names: ["ID"], types: [type], rows: [[value]] });
    const handle = await client.submit("SELECT ID", { numbers: "number" });
    const error = await handle.result().catch((error: unknown) => error);
    expect(error).toMatchObject(inexact("'ID'", "query-1"));
    for (const text of [(error as Error).message, JSON.stringify(error), inspect(error)])
      expect(text).not.toContain(value);
    expect(await handle.status()).toBe("SUCCESS");
    await client.close();
  });
  it("refers to an expression column by position so the error can't echo its value", async () => {
    const value = "12345678901234567890";
    const { client } = setup({
      names: ["ID", value],
      types: ["fixed", "fixed"],
      rows: [["1", value]],
    });
    const error = await client
      .query("synthetic", { numbers: "number" })
      .catch((error: unknown) => error);
    expect(error).toMatchObject(inexact("2", "query-1"));
    for (const text of [(error as Error).message, JSON.stringify(error), inspect(error)])
      expect(text).not.toContain(value);
    await client.close();
  });
  it("ignores numbers with native format", async () => {
    const fake = {
      names: ["ID", "RATIO"],
      types: ["fixed", "real"],
      rows: [["9007199254740993", "NaN"]],
    };
    const raw = [{ ID: "9007199254740993", RATIO: "NaN" }];
    const { client, driver } = setup(fake, { numbers: "number" });
    expect((await client.query("SELECT 1", { format: "native" })).rows).toEqual(raw);
    const handle = await client.submit("SELECT 1", { format: "native" });
    expect((await handle.result()).rows).toEqual(raw);
    const streamed: unknown[] = [];
    for await (const row of await client.stream("SELECT 1", { format: "native" }))
      streamed.push(row);
    expect(streamed).toEqual(raw);
    await client.close();
    const native = setup(fake, { format: "native", numbers: "number" });
    expect((await native.client.query("SELECT 1")).rows).toEqual(raw);
    await native.client.close();
    const manager = createConnectionManager(provider(), { driver });
    const queries = createQueryClient(manager, {
      results: { format: "native", numbers: "number" },
    });
    expect((await queries.query("SELECT 1")).rows).toEqual(raw);
    await queries.close();
    await manager.close();
  });
  it.each(["bigint", "Number", "", null, 1, true])("rejects numbers: %j", async (numbers) => {
    const { client, connections, driver } = setup();
    const rejection = { code: "INVALID_OPTIONS", message: "numbers must be 'string' or 'number'" };
    expect(thrown(() => createSarClient({ driver, results: { numbers } as never }))).toMatchObject(
      rejection,
    );
    const manager = createConnectionManager(provider(), { driver });
    expect(
      thrown(() => createQueryClient(manager, { results: { numbers } as never })),
    ).toMatchObject(rejection);
    await expect(client.query("SELECT 1", { numbers } as never)).rejects.toMatchObject(rejection);
    await expect(client.submitDetached("SELECT 1", { numbers } as never)).rejects.toMatchObject(
      rejection,
    );
    expect(connections).toHaveLength(0);
    await manager.close();
    await client.close();
  });
});

describe("detached number settings", () => {
  it("saves numbers in a reference only when it's 'number'", async () => {
    const { create } = detachedSetup();
    const plain = create();
    const reference = await plain.submitDetached("synthetic");
    expect(reference.results).toStrictEqual(defaults);
    expect(JSON.stringify(reference)).not.toContain("numbers");
    await plain.close();
    const client = create({ numbers: "number" });
    expect((await client.submitDetached("synthetic")).results).toStrictEqual({
      ...defaults,
      numbers: "number",
    });
    expect((await client.submitDetached("synthetic", { numbers: "string" })).results).toStrictEqual(
      defaults,
    );
    expect((await client.submitDetached("synthetic", { format: "native" })).results).toStrictEqual({
      ...defaults,
      format: "native",
      numbers: "number",
    });
    await client.close();
  });
  it("applies a saved numbers setting on another client", async () => {
    const { create, settings } = detachedSetup();
    settings.status = "SUCCESS";
    settings.names = ["TOTAL", "RATIO"];
    settings.types = ["fixed", "real"];
    settings.rows = [["12.50", "1e-07"]];
    const first = create({ numbers: "number" });
    const numbers = JSON.parse(JSON.stringify(await first.submitDetached("synthetic")));
    const native = JSON.parse(
      JSON.stringify(await first.submitDetached("synthetic", { format: "native" })),
    );
    await first.close();
    const second = create();
    await expect(second.pollQuery(numbers)).resolves.toMatchObject({
      status: "complete",
      result: { rows: [{ TOTAL: 12.5, RATIO: 1e-7 }] },
    });
    await expect(second.pollQuery(native)).resolves.toMatchObject({
      status: "complete",
      result: { rows: [{ TOTAL: "12.50", RATIO: "1e-07" }] },
    });
    await second.close();
  });
  it("reads a reference without numbers as strings, whatever the client default", async () => {
    const { create, settings } = detachedSetup();
    settings.status = "SUCCESS";
    settings.rows = [["42"]];
    const first = create();
    const saved = JSON.parse(JSON.stringify(await first.submitDetached("synthetic")));
    await first.close();
    expect(saved.results).not.toHaveProperty("numbers");
    const second = create({ numbers: "number" });
    expect(await second.getQueryStatus(saved)).toBe("SUCCESS");
    await expect(second.pollQuery(saved)).resolves.toMatchObject({
      status: "complete",
      result: { rows: [{ VALUE: "42" }] },
    });
    await expect(second.cancelQuery(saved)).resolves.toEqual({
      queryId: saved.queryId,
      cancelled: false,
      status: "SUCCESS",
    });
    await second.close();
  });
  it("fails an inexact saved number instead of reporting pending", async () => {
    const { create, settings, connections } = detachedSetup();
    settings.status = "SUCCESS";
    const client = create();
    const reference = await client.submitDetached("synthetic", { numbers: "number" });
    await expect(client.pollQuery(reference)).rejects.toMatchObject(
      inexact("'VALUE'", reference.queryId),
    );
    expect(await client.getQueryStatus(reference)).toBe("SUCCESS");
    const opened = connections.length;
    await expect(client.pollQuery(reference, { numbers: "string" } as never)).rejects.toMatchObject(
      { code: "INVALID_OPTIONS" },
    );
    expect(connections).toHaveLength(opened);
    await client.close();
  });
  it("normalizes saved results and validates a saved numbers setting", () => {
    const saved = { format: "json", rowMode: "object", maxRows: 100, maxBytes: 1024 } as const;
    const reference: QueryReference = {
      version: 1,
      queryId: "01000000-0000-0000-0000-00000000abcd",
      submittedAt: "2026-09-29T00:00:00.000Z",
      identity: { organization: "ORG", account: "ACCOUNT", user: "USER", role: "ROLE" },
      mode: "owner",
      results: { ...saved, numbers: "number" },
    };
    expect(queryReference(reference)).toEqual(reference);
    for (const results of [
      saved,
      { ...saved, numbers: undefined },
      { ...saved, numbers: "string" as const },
    ]) {
      const normalized = queryReference({ ...reference, results });
      expect(normalized.results).toStrictEqual(saved);
      expect(Object.isFrozen(normalized.results)).toBe(true);
    }
    const native = { ...saved, format: "native", numbers: "number" } as const;
    expect(queryReference({ ...reference, results: native }).results).toStrictEqual(native);
    for (const numbers of ["bigint", null, 1])
      expect(
        thrown(() => queryReference({ ...reference, results: { ...saved, numbers } } as never)),
      ).toMatchObject({ code: "INVALID_OPTIONS" });
  });
});
