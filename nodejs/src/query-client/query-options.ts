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
import { defined, duration, fail, keys, positive, signalOption } from "../core/errors.js";

/** Node driver bind values, passed through without SQL interpolation. */
export type Binds = snowflake.Binds;
/** Default materialization limits apply during row consumption, not afterward. */
export interface ResultOptions {
  format?: "json" | "native";
  rowMode?: "object" | "array";
  maxRows?: number;
  maxBytes?: number;
  /**
   * JSON-format NUMBER and FLOAT values. With "number", NUMBER values become JavaScript numbers
   * only when exact and FLOAT values when finite; anything else fails instead of losing
   * precision. Native format ignores this setting. Default: "string".
   */
  numbers?: "string" | "number";
}
/** Runtime-independent query controls. Timeouts are client deadlines, not rollback guarantees. */
export interface QueryOptions extends ResultOptions {
  /** Passed to the driver as bindings, never interpolated by the SDK. */
  binds?: Binds;
  warehouse?: string;
  /** Stops local waiting and requests best-effort cleanup, not guaranteed rollback. */
  signal?: AbortSignal;
  acquireTimeoutMs?: number;
  authTimeoutMs?: number;
  waitTimeoutMs?: number;
  consumeTimeoutMs?: number;
  /**
   * For submit() handles and transaction statements, the longest wait between status checks;
   * checks start after 25 ms and back off. query() and stream() don't poll. Default: 1 second.
   */
  pollIntervalMs?: number;
  /** Synchronous validation/transformation after SDK conversion. Promises are rejected. */
  decodeRow?: (row: unknown) => unknown;
}

/**
 * Statement controls. The result format, warehouse, and acquisition/authentication timeouts belong
 * to the transaction.
 */
export type TransactionQueryOptions = Pick<
  QueryOptions,
  | "binds"
  | "signal"
  | "waitTimeoutMs"
  | "consumeTimeoutMs"
  | "pollIntervalMs"
  | "rowMode"
  | "maxRows"
  | "maxBytes"
  | "numbers"
  | "decodeRow"
>;
/** Settings for the transaction's single session. */
export interface TransactionOptions {
  /**
   * Result format for every statement, defaulting to the client's. JSON sets the session's
   * temporal output formats once, before BEGIN.
   */
  format?: "json" | "native";
  /** Cancels the running statement best effort, rolls back when safe, and discards the session. */
  signal?: AbortSignal;
  warehouse?: string;
  acquireTimeoutMs?: number;
  authTimeoutMs?: number;
}

export type ResolvedQuery = QueryOptions &
  Required<Pick<QueryOptions, "format" | "rowMode" | "maxRows" | "maxBytes" | "numbers">>;
const queryKeys = [
  "binds",
  "warehouse",
  "signal",
  "acquireTimeoutMs",
  "authTimeoutMs",
  "waitTimeoutMs",
  "consumeTimeoutMs",
  "pollIntervalMs",
  "format",
  "rowMode",
  "maxRows",
  "maxBytes",
  "numbers",
  "decodeRow",
];
const sessionKeys = ["format", "warehouse", "acquireTimeoutMs", "authTimeoutMs"];

export function queryOptions(
  defaults: ResultOptions | undefined,
  provided: QueryOptions = {},
): ResolvedQuery {
  keys(provided, queryKeys, "query");
  const result = {
    format: "json",
    rowMode: "object",
    maxRows: 100_000,
    maxBytes: 32 * 1024 * 1024,
    numbers: "string",
    ...defined(defaults ?? {}),
    ...defined(provided),
  } as ResolvedQuery;
  if (!["json", "native"].includes(result.format) || !["object", "array"].includes(result.rowMode))
    fail("INVALID_OPTIONS", "Invalid result format or row mode");
  if (!["string", "number"].includes(result.numbers))
    fail("INVALID_OPTIONS", "numbers must be 'string' or 'number'");
  for (const key of [
    "acquireTimeoutMs",
    "authTimeoutMs",
    "waitTimeoutMs",
    "consumeTimeoutMs",
    "pollIntervalMs",
  ] as const)
    duration(result[key], key);
  for (const key of ["maxRows", "maxBytes"] as const) {
    positive(result[key], key);
    if (!Number.isSafeInteger(result[key]))
      fail("INVALID_OPTIONS", `${key} must be a safe integer`);
  }
  signalOption(result.signal);
  if (
    result.warehouse !== undefined &&
    (typeof result.warehouse !== "string" || !result.warehouse.trim())
  )
    fail("INVALID_OPTIONS", "warehouse must be a nonempty string");
  if (result.decodeRow !== undefined && typeof result.decodeRow !== "function")
    fail("INVALID_OPTIONS", "decodeRow must be a function");
  return result;
}

export function transactionOptions(
  defaults: ResultOptions | undefined,
  provided: TransactionOptions = {},
): ResolvedQuery {
  keys(provided, ["signal", ...sessionKeys], "transaction");
  return queryOptions(defaults, provided);
}

export function transactionQueryOptions(
  transaction: ResolvedQuery,
  provided: TransactionQueryOptions = {},
): ResolvedQuery {
  keys(
    provided,
    queryKeys.filter((key) => !sessionKeys.includes(key)),
    "transaction query",
  );
  const { format, rowMode, maxRows, maxBytes, numbers, warehouse } = transaction;
  return { ...queryOptions({ format, rowMode, maxRows, maxBytes, numbers }, provided), warehouse };
}

const resultKeys = ["format", "rowMode", "maxRows", "maxBytes", "numbers"];

/** Validates client-wide result defaults and returns a copy. */
export function resultOptions(input: ResultOptions | undefined): ResultOptions {
  keys(input === undefined ? {} : input, resultKeys, "results");
  const copy = { ...input };
  queryOptions(copy);
  return copy;
}
