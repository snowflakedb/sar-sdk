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

import type snowflake from "snowflake-sdk";
import { SarError, fail } from "../core/errors.js";
import type { QueryOptions } from "./query-options.js";

/** Resolved column metadata. Temporal type identifies NTZ, LTZ, or TZ semantics. */
export interface ColumnMetadata {
  name: string;
  type: string;
  index: number;
  nullable: boolean;
  precision: number | null;
  scale: number | null;
}
/** rowCount counts returned rows, not rows affected by DML; see affectedRows. */
export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  queryId: string;
  columns: ColumnMetadata[];
  rowCount: number;
  /** Rows inserted, updated, deleted, or merged, when Snowflake reports a DML count. */
  affectedRows?: number;
}
/** Single-consumer stream. Break iteration or call close to release the session. */
export interface RowStream<Row = Record<string, unknown>> extends AsyncIterable<Row> {
  readonly queryId: string;
  readonly columns: ColumnMetadata[];
  close(): Promise<void>;
}

// Only these scalar families stringify SQL NULL as this sentinel in driver 3.3.0.
// Never apply this to text or VARIANT, whose contents can legitimately be "NULL".
const nullSentinelTypes = new Set([
  "fixed",
  "real",
  "date",
  "time",
  "timestamp_ntz",
  "timestamp_ltz",
  "timestamp_tz",
]);

// The driver parses these into JavaScript values even when fetching JSON as strings, rounding
// large numbers. VARIANT keeps its JSON text.
const containerTypes = new Map([
  ["object", "an OBJECT"],
  ["array", "an ARRAY"],
  ["map", "a MAP"],
]);

// Snowflake names an unaliased expression column after its SQL text, which can contain literals.
const identifier = /^[A-Za-z_][A-Za-z0-9_$]*$/;

// The driver's getNumUpdatedRows() adds every DML summary column, including an UPDATE's
// "number of multi-joined rows updated", which repeats rows already counted.
const rowCountColumn = /^number of rows /i;

function columnLabel(name: string, index: number): string {
  return identifier.test(name) ? `'${name}'` : String(index + 1);
}

export const temporalSessionSql = `ALTER SESSION SET
  DATE_OUTPUT_FORMAT = 'YYYY-MM-DD', TIME_OUTPUT_FORMAT = 'HH24:MI:SS.FF9',
  TIMESTAMP_NTZ_OUTPUT_FORMAT = 'YYYY-MM-DDTHH24:MI:SS.FF9',
  TIMESTAMP_LTZ_OUTPUT_FORMAT = 'YYYY-MM-DDTHH24:MI:SS.FF9TZH:TZM',
  TIMESTAMP_TZ_OUTPUT_FORMAT = 'YYYY-MM-DDTHH24:MI:SS.FF9TZH:TZM'`;

export const temporalResetSql = `ALTER SESSION UNSET
  DATE_OUTPUT_FORMAT, TIME_OUTPUT_FORMAT, TIMESTAMP_NTZ_OUTPUT_FORMAT,
  TIMESTAMP_LTZ_OUTPUT_FORMAT, TIMESTAMP_TZ_OUTPUT_FORMAT`;

export function executionOptions(options: QueryOptions): Partial<snowflake.StatementOption> {
  return {
    rowMode: "array",
    streamResult: true,
    fetchAsString: options.format === "native" ? [] : ["Number", "Date", "JSON"],
    parameters: {
      MULTI_STATEMENT_COUNT: 1,
      ...(options.warehouse ? { QUERY_WAREHOUSE_NAME: options.warehouse } : {}),
      ...(options.format === "native"
        ? {}
        : {
            DATE_OUTPUT_FORMAT: "YYYY-MM-DD",
            TIME_OUTPUT_FORMAT: "HH24:MI:SS.FF9",
            TIMESTAMP_NTZ_OUTPUT_FORMAT: "YYYY-MM-DDTHH24:MI:SS.FF9",
            TIMESTAMP_LTZ_OUTPUT_FORMAT: "YYYY-MM-DDTHH24:MI:SS.FF9TZH:TZM",
            TIMESTAMP_TZ_OUTPUT_FORMAT: "YYYY-MM-DDTHH24:MI:SS.FF9TZH:TZM",
          }),
    },
  };
}

export function metadata(
  statement: snowflake.RowStatement,
  options: QueryOptions,
): ColumnMetadata[] {
  const driverColumns = statement.getColumns();
  if (!driverColumns)
    fail("RESULT_CONVERSION_UNSUPPORTED", "Driver result metadata is unavailable");
  if (options.format !== "native") {
    for (const [index, column] of driverColumns.entries()) {
      const type = containerTypes.get(column.getType().toLowerCase());
      if (type)
        throw new SarError(
          "RESULT_CONVERSION_UNSUPPORTED",
          `Column ${columnLabel(column.getName(), index)} is ${type}, which JSON results can't return exactly. Cast it to VARIANT to receive its JSON text, or use format: 'native'.`,
          {
            nextStep:
              "Cast the column to VARIANT, for example ARRAY_AGG(X)::VARIANT, or use format: 'native'.",
          },
        );
    }
  }
  const columns = driverColumns.map((column, index) => ({
    name: column.getName(),
    type: column.getType(),
    index,
    nullable: column.isNullable(),
    precision: column.getPrecision(),
    scale: column.getScale(),
  }));
  if (options.rowMode !== "array") {
    const names = new Set<string>();
    for (const { name, index } of columns) {
      if (names.has(name)) {
        const nextStep = "Alias the duplicate columns, or use rowMode: 'array'.";
        throw new SarError(
          "DUPLICATE_COLUMNS",
          `Column ${columnLabel(name, index)} repeats an earlier column name. ${nextStep}`,
          { nextStep },
        );
      }
      names.add(name);
    }
  }
  return columns;
}

export function isDml(statement: snowflake.RowStatement): boolean {
  try {
    return (statement.getNumUpdatedRows?.() ?? -1) >= 0;
  } catch {
    // The statement already succeeded; a driver failure here must not report it as failed.
    return false;
  }
}

export function dmlCount(row: unknown, columns: ColumnMetadata[]): number | undefined {
  if (!Array.isArray(row)) return undefined;
  const counted = columns.filter((column) => rowCountColumn.test(column.name));
  const total = counted.reduce((sum, column) => sum + Number(row[column.index]), 0);
  return counted.length > 0 && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

const decimalText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const floatText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const numbersNextStep = "Use numbers: 'string', or cast the column to VARCHAR.";

/** Decimal text without a leading "+", redundant zeros, or a sign on zero. */
function canonical(text: string): string {
  const [whole = "", fraction = ""] = text.replace(/^[+-]/, "").split(".");
  const integer = whole.replace(/^0+/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  const digits = decimals ? `${integer}.${decimals}` : integer;
  return text.startsWith("-") && digits !== "0" ? `-${digits}` : digits;
}

/** The canonical decimal of a number's shortest form, expanded when it uses an exponent. */
function positional(value: number): string {
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const [whole = "", fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const unsigned =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : `${digits.slice(0, point).padEnd(point, "0")}.${digits.slice(point)}`;
  return canonical(mantissa.startsWith("-") ? `-${unsigned}` : unsigned);
}

/** NUMBER text as a safe integer, or a decimal with the same digits as its number; else undefined. */
function exactNumber(text: string): number | undefined {
  if (!decimalText.test(text)) return undefined;
  const digits = canonical(text);
  const value = Number(digits);
  const exact = digits.includes(".") ? positional(value) === digits : Number.isSafeInteger(value);
  return exact ? value : undefined;
}

/** FLOAT text as the number it denotes when that is finite; else undefined. */
function finiteNumber(text: string): number | undefined {
  const value = floatText.test(text) ? Number(text) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function convertRow(
  row: unknown,
  columns: ColumnMetadata[],
  options: QueryOptions,
): unknown {
  if (!Array.isArray(row))
    fail("RESULT_CONVERSION_UNSUPPORTED", "Driver must support array-mode result rows");
  if (row.length !== columns.length)
    fail("RESULT_CONVERSION_UNSUPPORTED", "Driver row width does not match result metadata");
  const values = row.map((value: unknown, index: number) => {
    if (options.format === "native" || value === null) return value;
    const type = columns[index]?.type.toLowerCase();
    if (value === "NULL" && type && nullSentinelTypes.has(type)) return null;
    if (options.numbers === "number" && (type === "fixed" || type === "real")) {
      if (typeof value === "number" && type === "real" && Number.isFinite(value)) return value;
      if (typeof value === "string" || typeof value === "bigint") {
        const number = type === "real" ? finiteNumber(String(value)) : exactNumber(String(value));
        if (number !== undefined) return number;
        throw new SarError(
          "RESULT_CONVERSION_UNSUPPORTED",
          `Column ${columnLabel(columns[index]?.name ?? "", index)} has a value that can't be returned as an exact, finite JavaScript number. ${numbersNextStep}`,
          { completion: "succeeded", nextStep: numbersNextStep },
        );
      }
    }
    if (Buffer.isBuffer(value)) return value.toString("base64");
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && type === "real" && Number.isFinite(value))
      return String(value);
    throw new SarError(
      "RESULT_CONVERSION_UNSUPPORTED",
      `Driver did not preserve a JSON-safe representation for column ${columnLabel(columns[index]?.name ?? "", index)}. Use format: 'native' explicitly.`,
      { completion: "succeeded" },
    );
  });
  const converted =
    options.rowMode === "array"
      ? values
      : Object.fromEntries(columns.map((column, index) => [column.name, values[index]]));
  const decoded = options.decodeRow ? options.decodeRow(converted) : converted;
  if (
    decoded !== null &&
    (typeof decoded === "object" || typeof decoded === "function") &&
    "then" in decoded &&
    typeof decoded.then === "function"
  ) {
    void Promise.resolve(decoded).catch(() => {});
    fail("INVALID_OPTIONS", "decodeRow must return a synchronous value, not a Promise");
  }
  return decoded;
}

export function rowBytes(row: unknown): number {
  try {
    return Buffer.byteLength(
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  } catch {
    return fail(
      "RESULT_CONVERSION_UNSUPPORTED",
      "Row decoder returned a cyclic or non-serializable result",
    );
  }
}
