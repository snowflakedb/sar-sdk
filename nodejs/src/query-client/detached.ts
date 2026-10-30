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
import {
  detachedOptions,
  identityKeys,
  lookupOptions,
  pollOptions,
  queryIdentity,
  queryReference,
  resultSettings,
} from "./detached-options.js";
import { cancellationDetails, fail, operationError, SarError } from "../core/errors.js";
import { checkAbort, deadline } from "../core/lifecycle.js";
import { completion, detachedInternals, type Lease } from "../connection-manager/lease.js";
import { failedQuery, fetchResult, queryState } from "./driver-adapter.js";
import { queryOptions, type ResolvedQuery } from "./query-options.js";
import { executionOptions, temporalSessionSql } from "./results.js";
import type { ConnectionScope } from "../connection-manager/lease.js";
import type {
  DetachedQueryOptions,
  PollQueryOptions,
  QueryIdentity,
  QueryLookupOptions,
  QueryReference,
} from "./detached-options.js";
import type { QueryOptions, ResultOptions } from "./query-options.js";
import type { QueryResult, RowStream } from "./results.js";

export type QueryPollResult<Row = Record<string, unknown>> =
  | { status: "pending"; queryId: string }
  | { status: "complete"; queryId: string; result: QueryResult<Row> };
/** The stream reads every row; the reference's maxRows and maxBytes don't apply. */
export type QueryStreamResult<Row = Record<string, unknown>> =
  | { status: "pending"; queryId: string }
  | { status: "complete"; queryId: string; stream: RowStream<Row> };
/**
 * `cancelled: true` only when this call requested cancellation and Snowflake confirmed it, or a
 * status check afterward found it cancelled: FAILED_WITH_ERROR with error 000604, which is how
 * Snowflake reports a cancelled query, or ABORTED. Otherwise `status` is the terminal status
 * observed: the query had already finished, including after an earlier cancellation, or it
 * finished before cancellation took effect.
 */
export type QueryCancellation =
  { queryId: string; cancelled: true } | { queryId: string; cancelled: false; status: string };
export interface DetachedQueryScope {
  /** Return a reference after acknowledgement and local cleanup, without checking completion. */
  submitDetached(sql: string, options?: DetachedQueryOptions): Promise<QueryReference>;
  /** Check status once and fetch only completed results. The HTTP client schedules later polls. */
  pollQuery<Row = Record<string, unknown>>(
    reference: QueryReference,
    options?: PollQueryOptions,
  ): Promise<QueryPollResult<Row>>;
  /**
   * Check status once like pollQuery, and stream a completed result for export. The stream holds
   * a lookup connection until it ends, is closed, aborts, or times out; it never cancels the query.
   */
  streamQuery<Row = Record<string, unknown>>(
    reference: QueryReference,
    options?: PollQueryOptions,
  ): Promise<QueryStreamResult<Row>>;
  getQueryStatus(reference: QueryReference, options?: QueryLookupOptions): Promise<string>;
  /**
   * Requests cancellation unless the query already finished, not guaranteed rollback. Does not
   * delete a server session. Throws if an unconfirmed request leaves the query still running.
   */
  cancelQuery(reference: QueryReference, options?: QueryLookupOptions): Promise<QueryCancellation>;
}

type Acquire = (settings: QueryOptions) => Promise<Lease>;

const identitySql = `SELECT CURRENT_ORGANIZATION_NAME() AS "organization",
  CURRENT_ACCOUNT_NAME() AS "account", CURRENT_USER() AS "user", CURRENT_ROLE() AS "role"`;

async function control(
  lease: Lease,
  sqlText: string,
  expires: number,
  binds?: snowflake.Binds,
): Promise<Record<string, unknown>[]> {
  checkAbort(lease.signal);
  if (performance.now() >= expires) fail("TIMEOUT", "Query control timeout exceeded");
  const pending = new Promise<Record<string, unknown>[]>((resolve, reject) => {
    lease.connection.execute({
      sqlText,
      binds,
      rowMode: "object",
      streamResult: false,
      parameters: { MULTI_STATEMENT_COUNT: 1 },
      complete(error, _statement, rows) {
        if (error) reject(error);
        else resolve(rows as Record<string, unknown>[]);
      },
    });
  });
  return deadline(pending, expires - performance.now(), lease.signal, "Query control", expires);
}

async function identity(lease: Lease, expires: number): Promise<QueryIdentity> {
  const rows = await control(lease, identitySql, expires);
  if (!Array.isArray(rows) || rows.length !== 1)
    fail("QUERY_IDENTITY_MISMATCH", "Authenticated query identity is unavailable");
  try {
    return queryIdentity(rows[0] as unknown as QueryIdentity);
  } catch {
    return fail("QUERY_IDENTITY_MISMATCH", "Authenticated query identity is incomplete");
  }
}

async function parameter(lease: Lease, name: string, expires: number): Promise<string> {
  // Names are SDK constants, never request input.
  const rows = await control(lease, `SHOW PARAMETERS LIKE '${name}' IN SESSION`, expires);
  const row = Array.isArray(rows) ? rows.find((row) => row.key === name) : undefined;
  if (!row || typeof row.value !== "string")
    fail("DETACHED_QUERY_NOT_SUPPORTED", `Cannot verify ${name} for detached submission`);
  return row.value;
}

export async function submitDetached(
  sql: string,
  provided: DetachedQueryOptions | undefined,
  defaults: ResultOptions | undefined,
  mode: QueryReference["mode"],
  acquire: Acquire,
): Promise<QueryReference> {
  if (typeof sql !== "string" || !sql.trim())
    fail("INVALID_OPTIONS", "SQL must be a nonempty string");
  const { settings, submitTimeoutMs, executionSeconds } = detachedOptions(defaults, provided);
  const lease = await acquire(settings);
  const expires = performance.now() + submitTimeoutMs;
  let statement: snowflake.RowStatement | undefined;
  let dispatched = false;
  let acknowledged = false;
  let cancelPromise: Promise<void> | undefined;
  lease.cancel = () => {
    if (acknowledged || !statement || lease.released) return Promise.resolve();
    cancelPromise ??= deadline(
      new Promise<void>((resolve, reject) => {
        statement!.cancel((error) => (error ? reject(error) : resolve()));
      }),
      5_000,
      undefined,
      "Submission cancellation",
    );
    return cancelPromise;
  };
  try {
    const submittingIdentity = await identity(lease, expires);
    if ((await parameter(lease, "ABORT_DETACHED_QUERY", expires)).toLowerCase() !== "false")
      fail(
        "DETACHED_QUERY_NOT_SUPPORTED",
        "Detached submission requires ABORT_DETACHED_QUERY = FALSE; the SDK does not change this policy",
      );
    if ((await parameter(lease, "AUTOCOMMIT", expires)).toLowerCase() !== "true")
      fail("DETACHED_QUERY_NOT_SUPPORTED", "Detached submission requires AUTOCOMMIT = TRUE");
    const currentLimit = await parameter(lease, "STATEMENT_TIMEOUT_IN_SECONDS", expires);
    if (!/^\d+$/.test(currentLimit) || !Number.isSafeInteger(Number(currentLimit)))
      fail("DETACHED_QUERY_NOT_SUPPORTED", "Cannot verify the effective statement timeout");
    const limit = Math.min(executionSeconds, Number(currentLimit) || 604_800);
    const initialization =
      settings.format === "native" ? "ALTER SESSION SET" : `${temporalSessionSql},`;
    await control(lease, `${initialization} STATEMENT_TIMEOUT_IN_SECONDS = ${limit}`, expires);
    checkAbort(lease.signal);
    if (performance.now() >= expires) fail("TIMEOUT", "Query submission timeout exceeded");
    const submittedAt = new Date().toISOString();
    const submission = new Promise<void>((resolve, reject) => {
      dispatched = true;
      statement = lease.connection.execute({
        ...executionOptions(settings),
        sqlText: sql,
        binds: settings.binds,
        asyncExec: true,
        complete(error, submitted) {
          if (error) reject(error);
          else {
            // Change ownership in the callback, before an abort/close can observe acknowledgement.
            acknowledged = true;
            lease.cancel = undefined;
            try {
              lease.queryId = submitted.getQueryId();
              resolve();
            } catch (error) {
              reject(error);
            }
          }
        },
      });
    });
    await deadline(submission, submitTimeoutMs, lease.signal, "Submission", expires);
    const reference = queryReference({
      version: 1,
      queryId: lease.queryId!,
      submittedAt,
      identity: submittingIdentity,
      mode,
      results: resultSettings(settings),
    });
    await lease.release();
    return reference;
  } catch (error) {
    try {
      await lease.cancel?.();
    } catch {
      // The original error and unknown outcome take precedence over best-effort cancellation.
    }
    await lease.release().catch(() => {});
    let knownId = lease.queryId;
    if (!knownId) {
      try {
        knownId = statement?.getQueryId();
      } catch {
        // A malformed driver statement must not replace the operational error.
      }
    }
    throw operationError(error, "Detached submission failed; SQL was not replayed", {
      queryId: knownId,
      completion: dispatched ? "unknown" : "not-submitted",
    });
  }
}

async function verifyIdentity(lease: Lease, reference: QueryReference, expires: number) {
  const current = await identity(lease, expires);
  if (identityKeys.some((key) => current[key] !== reference.identity[key]))
    fail(
      "QUERY_IDENTITY_MISMATCH",
      "Query reference does not match the authenticated account, user, and role",
    );
}

async function status(lease: Lease): Promise<string> {
  checkAbort(lease.signal);
  const value = await lease.connection.getQueryStatus(lease.queryId!);
  checkAbort(lease.signal);
  if (typeof value !== "string" || !value.trim())
    fail("QUERY_FAILED", "Driver returned an invalid query status");
  if (value === "NO_QUERY_DATA")
    throw new SarError(
      "QUERY_UNAVAILABLE",
      "Query is unavailable; it may be expired, inaccessible, or unknown",
      {
        queryId: lease.queryId,
        completion: "unknown",
      },
    );
  if (queryState(value) !== "pending") lease.serverStatus = value;
  return value;
}

/** Check status once and fetch only a completed result; undefined means pending. */
async function retrieve(
  lease: Lease,
  reference: QueryReference,
  settings: ReturnType<typeof pollOptions>,
  expires: number,
): Promise<{ statement: snowflake.RowStatement; settings: ResolvedQuery } | undefined> {
  const value = await deadline(
    status(lease),
    settings.lookupTimeoutMs,
    lease.signal,
    "Query status",
    expires,
  );
  const state = queryState(value);
  if (state === "pending") return undefined;
  if (state === "failed")
    throw await failedQuery(
      lease.connection,
      reference.queryId,
      Math.min(5_000, Math.max(1, expires - performance.now())),
      lease.signal,
    );

  // Result fetch does not send statement parameters; set formats on the lookup session too.
  if (reference.results.format === "json") await control(lease, temporalSessionSql, expires);
  const resultOptions = queryOptions(reference.results, {
    signal: lease.signal,
    consumeTimeoutMs: settings.consumeTimeoutMs,
    decodeRow: settings.decodeRow,
  });
  checkAbort(lease.signal);
  if (performance.now() >= expires) fail("TIMEOUT", "Result fetch deadline exceeded");
  const statement = await deadline(
    fetchResult(lease.connection, reference.queryId, executionOptions(resultOptions)),
    settings.lookupTimeoutMs,
    lease.signal,
    "Result fetch",
    expires,
  );
  return { statement, settings: resultOptions };
}

export function createDetachedScope(
  scoped: ConnectionScope,
  hooks: {
    assertOpen(): void;
    acquire: Acquire;
    results?: ResultOptions;
    materialize<Row>(
      lease: Lease,
      statement: snowflake.RowStatement,
      settings: ResolvedQuery,
    ): Promise<QueryResult<Row>>;
    stream<Row>(
      lease: Lease,
      statement: snowflake.RowStatement,
      settings: ResolvedQuery,
    ): RowStream<Row>;
  },
): DetachedQueryScope {
  function check(reference?: QueryReference) {
    hooks.assertOpen();
    const internals = detachedInternals(scoped);
    if (reference && reference.mode !== internals.mode)
      fail("QUERY_IDENTITY_MISMATCH", "Query reference belongs to a different owner/caller mode");
    return internals.mode;
  }
  async function lookup<T>(
    reference: QueryReference,
    settings: ReturnType<typeof lookupOptions>,
    operation: (lease: Lease, expires: number) => Promise<T>,
    owns: (result: T) => boolean = () => false,
  ): Promise<T> {
    let lease: Lease;
    try {
      lease = await hooks.acquire(settings);
    } catch (error) {
      const failure = operationError(error, "Detached query connection failed");
      // A failed lookup login says nothing about the already submitted query.
      throw new SarError(
        failure.code,
        failure.message,
        {
          ...failure.details,
          queryId: reference.queryId,
          completion: "unknown",
        },
        error,
      );
    }
    lease.queryId = reference.queryId;
    let failed = false;
    let transferred = false;
    try {
      const expires = performance.now() + settings.lookupTimeoutMs;
      await verifyIdentity(lease, reference, expires);
      checkAbort(lease.signal);
      const result = await operation(lease, expires);
      transferred = owns(result);
      return result;
    } catch (error) {
      failed = true;
      throw operationError(error, "Detached query operation failed; SQL was not replayed", {
        queryId: reference.queryId,
        completion: completion(lease),
      });
    } finally {
      // A returned stream owns the lease and releases it when consumption ends.
      if (!transferred) {
        // Abort only local observation/consumption. Detached lookups never install a cancel hook.
        lease.controller.abort();
        if (failed) await lease.release().catch(() => {});
        else await lease.release();
      }
    }
  }
  return Object.freeze<DetachedQueryScope>({
    async submitDetached(sql, provided) {
      const mode = check();
      return submitDetached(sql, provided, hooks.results, mode, hooks.acquire);
    },
    async getQueryStatus(input, provided) {
      const reference = queryReference(input);
      const settings = lookupOptions(provided);
      check(reference);
      return lookup(reference, settings, (lease, expires) =>
        deadline(status(lease), settings.lookupTimeoutMs, lease.signal, "Query status", expires),
      );
    },
    async cancelQuery(input, provided) {
      const reference = queryReference(input);
      const settings = lookupOptions(provided);
      check(reference);
      return lookup<QueryCancellation>(reference, settings, async (lease, expires) => {
        const value = await deadline(
          status(lease),
          settings.lookupTimeoutMs,
          lease.signal,
          "Query status",
          expires,
        );
        if (queryState(value) !== "pending")
          return { queryId: reference.queryId, cancelled: false, status: value };
        let refusal: unknown;
        try {
          const rows = await control(lease, 'SELECT SYSTEM$CANCEL_QUERY(?) AS "status"', expires, [
            reference.queryId,
          ]);
          if (
            rows?.length === 1 &&
            typeof rows[0]?.status === "string" &&
            rows[0].status.toLowerCase() ===
              `query [${reference.queryId.toLowerCase()}] terminated.`
          )
            return { queryId: reference.queryId, cancelled: true };
        } catch (error) {
          checkAbort(lease.signal);
          if (performance.now() >= expires) throw error;
          refusal = error;
        }
        const after = await deadline(
          status(lease),
          settings.lookupTimeoutMs,
          lease.signal,
          "Cancellation status",
          expires,
        );
        if (queryState(after) === "pending")
          throw new SarError(
            "QUERY_FAILED",
            "Query cancellation could not be confirmed",
            {
              queryId: reference.queryId,
              completion: "unknown",
              ...cancellationDetails(refusal, reference.mode),
            },
            refusal,
          );
        if (after === "ABORTED") return { queryId: reference.queryId, cancelled: true };
        if (after === "FAILED_WITH_ERROR") {
          const failure = await failedQuery(
            lease.connection,
            reference.queryId,
            Math.min(5_000, Math.max(1, expires - performance.now())),
            lease.signal,
          );
          // Snowflake reports a cancelled query as FAILED_WITH_ERROR with error 000604.
          if (failure.details.errorCode === "000604")
            return { queryId: reference.queryId, cancelled: true };
        }
        return { queryId: reference.queryId, cancelled: false, status: after };
      });
    },
    async pollQuery<Row>(input: QueryReference, provided?: PollQueryOptions) {
      const reference = queryReference(input);
      const settings = pollOptions(provided);
      check(reference);
      checkAbort(settings.signal);
      return lookup(reference, settings, async (lease, expires) => {
        const fetched = await retrieve(lease, reference, settings, expires);
        if (!fetched) return { status: "pending" as const, queryId: reference.queryId };
        const result = await hooks.materialize<Row>(lease, fetched.statement, fetched.settings);
        return { status: "complete" as const, queryId: reference.queryId, result };
      });
    },
    async streamQuery<Row>(input: QueryReference, provided?: PollQueryOptions) {
      const reference = queryReference(input);
      const settings = pollOptions(provided);
      check(reference);
      checkAbort(settings.signal);
      return lookup(
        reference,
        settings,
        async (lease, expires) => {
          const fetched = await retrieve(lease, reference, settings, expires);
          if (!fetched) return { status: "pending" as const, queryId: reference.queryId };
          const stream = hooks.stream<Row>(lease, fetched.statement, fetched.settings);
          return { status: "complete" as const, queryId: reference.queryId, stream };
        },
        (outcome) => outcome.status === "complete",
      );
    },
  });
}
