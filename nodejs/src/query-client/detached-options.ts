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

import { duration, fail, keys, signalOption } from "../core/errors.js";
import { queryOptions, type QueryOptions, type ResultOptions } from "./query-options.js";

/** Server-reported identity, not a login credential or request-supplied target. */
export interface QueryIdentity {
  readonly organization: string;
  readonly account: string;
  readonly user: string;
  readonly role: string;
}
/** Store on the server with application authorization; this is not a bearer credential. */
export interface QueryReference {
  readonly version: 1;
  readonly queryId: string;
  readonly submittedAt: string;
  readonly identity: QueryIdentity;
  readonly mode: "owner" | "caller";
  /** Saved result settings. numbers is saved only as "number"; a missing value means "string". */
  readonly results: Readonly<
    Required<Omit<ResultOptions, "numbers">> & Pick<ResultOptions, "numbers">
  >;
}

/** One self-contained statement whose lifetime is independent of the submitting request. */
export interface DetachedQueryOptions
  extends
    ResultOptions,
    Pick<QueryOptions, "binds" | "warehouse" | "signal" | "acquireTimeoutMs" | "authTimeoutMs"> {
  /** Bounds setup and acknowledgement after login, not execution. Default: 30 seconds. */
  submitTimeoutMs?: number;
  /** Server execution limit, rounded down to whole seconds. Range: 1 second to 7 days. */
  executionTimeoutMs?: number;
}
export interface QueryLookupOptions {
  /** Aborts this lookup, never the detached query. Use cancelQuery for cancellation. */
  signal?: AbortSignal;
  acquireTimeoutMs?: number;
  authTimeoutMs?: number;
  /** Shared deadline for identity, status, and setup/fetch/cancel after login. Default: 30 seconds. */
  lookupTimeoutMs?: number;
}
export interface PollQueryOptions extends QueryLookupOptions {
  /** Bounds reading a completed result; expiry throws without cancelling the query. */
  consumeTimeoutMs?: number;
  /** Trusted synchronous decoder; not saved in the reference. */
  decodeRow?: (row: unknown) => unknown;
}

const resultKeys = ["format", "rowMode", "maxRows", "maxBytes", "numbers"] as const;
const lookupKeys = ["signal", "acquireTimeoutMs", "authTimeoutMs", "lookupTimeoutMs"];
export const identityKeys = ["organization", "account", "user", "role"] as const;

function queryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    fail("INVALID_OPTIONS", "Query ID must be a Snowflake UUID");
  return value;
}

export function queryIdentity(input: QueryIdentity): QueryIdentity {
  keys(input, identityKeys, "query identity");
  const snapshot = { ...input };
  for (const key of identityKeys) {
    if (typeof snapshot[key] !== "string" || !snapshot[key].trim())
      fail("INVALID_OPTIONS", `Query identity requires ${key}`);
  }
  return Object.freeze(snapshot);
}

export function resultSettings(input: ResultOptions = {}): QueryReference["results"] {
  const settings = queryOptions(input);
  return Object.freeze({
    format: settings.format,
    rowMode: settings.rowMode,
    maxRows: settings.maxRows,
    maxBytes: settings.maxBytes,
    // Earlier versions reject unknown result keys, so the default isn't saved.
    ...(settings.numbers === "number" ? { numbers: settings.numbers } : {}),
  });
}

export function queryReference(input: QueryReference): QueryReference {
  keys(
    input,
    ["version", "queryId", "submittedAt", "identity", "mode", "results"],
    "query reference",
  );
  const snapshot = { ...input };
  if (snapshot.version !== 1) fail("INVALID_OPTIONS", "Unsupported query reference version");
  queryId(snapshot.queryId);
  if (
    typeof snapshot.submittedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.submittedAt)) ||
    new Date(snapshot.submittedAt).toISOString() !== snapshot.submittedAt
  )
    fail("INVALID_OPTIONS", "Query reference requires an ISO submission timestamp");
  if (!["owner", "caller"].includes(snapshot.mode))
    fail("INVALID_OPTIONS", "Query reference requires owner or caller mode");
  keys(snapshot.results, resultKeys, "query reference results");
  for (const key of resultKeys) {
    // numbers is saved only as "number"; a missing value means "string".
    if (snapshot.results[key] === undefined && key !== "numbers")
      fail("INVALID_OPTIONS", `Query reference results require ${key}`);
  }
  return Object.freeze({
    ...snapshot,
    identity: queryIdentity(snapshot.identity),
    results: resultSettings(snapshot.results),
  });
}

export function detachedOptions(
  defaults: ResultOptions | undefined,
  input: DetachedQueryOptions = {},
) {
  keys(
    input,
    [
      ...resultKeys,
      "binds",
      "warehouse",
      "signal",
      "acquireTimeoutMs",
      "authTimeoutMs",
      "submitTimeoutMs",
      "executionTimeoutMs",
    ],
    "detached query",
  );
  const { submitTimeoutMs = 30_000, executionTimeoutMs = 600_000, ...provided } = input;
  duration(submitTimeoutMs, "submitTimeoutMs");
  if (
    !Number.isSafeInteger(executionTimeoutMs) ||
    executionTimeoutMs < 1_000 ||
    executionTimeoutMs > 604_800_000
  )
    fail("INVALID_OPTIONS", "executionTimeoutMs must be an integer from 1000 to 604800000");
  return {
    settings: queryOptions(defaults, provided),
    submitTimeoutMs,
    executionSeconds: Math.floor(executionTimeoutMs / 1_000),
  };
}

export function lookupOptions(
  input: QueryLookupOptions = {},
): Required<Pick<QueryLookupOptions, "lookupTimeoutMs">> & QueryLookupOptions {
  keys(input, lookupKeys, "query lookup");
  const { lookupTimeoutMs = 30_000 } = input;
  const snapshot = { ...input, lookupTimeoutMs };
  for (const key of ["acquireTimeoutMs", "authTimeoutMs", "lookupTimeoutMs"] as const)
    duration(snapshot[key], key);
  signalOption(snapshot.signal);
  return snapshot;
}

export function pollOptions(input: PollQueryOptions = {}) {
  keys(input, [...lookupKeys, "consumeTimeoutMs", "decodeRow"], "query poll");
  const { consumeTimeoutMs, decodeRow, ...lookup } = input;
  duration(consumeTimeoutMs, "consumeTimeoutMs");
  if (decodeRow !== undefined && typeof decodeRow !== "function")
    fail("INVALID_OPTIONS", "decodeRow must be a function");
  return { ...lookupOptions(lookup), consumeTimeoutMs, decodeRow };
}
