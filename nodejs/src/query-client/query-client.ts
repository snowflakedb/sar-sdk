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
import { failedQuery, fetchResult, queryState, statementFailure } from "./driver-adapter.js";
import {
  connectionInternals,
  detachedInternals,
  completion,
  type Lease,
} from "../connection-manager/lease.js";
import { createDetachedScope } from "./detached.js";
import {
  cancellationDetails,
  defined,
  duration,
  fail,
  isSarError,
  keys,
  operationError,
  SarError,
  signalOption,
  snowflakeDetails,
} from "../core/errors.js";
import { checkAbort, deadline, elapsed, pause } from "../core/lifecycle.js";
import {
  queryOptions,
  resultOptions,
  transactionOptions,
  transactionQueryOptions,
  type ResolvedQuery,
} from "./query-options.js";
import {
  convertRow,
  dmlCount,
  executionOptions,
  isDml,
  metadata,
  rowBytes,
  temporalResetSql,
  temporalSessionSql,
} from "./results.js";
import type { CallerContext } from "../connection-options/caller.js";
import type { ConnectionManager } from "../connection-manager/connection-manager.js";
import type { ConnectionScope } from "../connection-manager/lease.js";
import type { CloseOptions, LogEvent } from "../core/lifecycle.js";
import { timeoutOptions, type TimeoutOptions } from "../core/timeouts.js";
import type { DetachedQueryScope } from "./detached.js";
import type { PollQueryOptions, QueryReference } from "./detached-options.js";
import type {
  QueryOptions,
  ResultOptions,
  TransactionOptions,
  TransactionQueryOptions,
} from "./query-options.js";
import type { QueryResult, RowStream } from "./results.js";

export type QueryClientOptions = {
  results?: ResultOptions;
  timeouts?: TimeoutOptions;
  handleIdleTimeoutMs?: number;
};
/** A process-local handle. Repeated result calls never resubmit the statement. */
export interface QueryHandle<Row = Record<string, unknown>> {
  readonly queryId: string;
  /** Server execution status; local result failures do not rewrite a known SUCCESS. */
  status(): Promise<string>;
  /** First call chooses deadlines and memoizes its result or failure. Never resubmits SQL. */
  result(options?: { signal?: AbortSignal; waitTimeoutMs?: number }): Promise<QueryResult<Row>>;
  /** Idempotent local cancellation/disposal, with best-effort server cancellation. */
  cancel(): Promise<void>;
}
/** Runs statements on the transaction's session one at a time, in call order. */
export interface Transaction {
  /** Materialized result, as from query(). Rejects once the transaction has ended. */
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: TransactionQueryOptions,
  ): Promise<QueryResult<Row>>;
}
export interface QueryScope extends DetachedQueryScope {
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: QueryOptions,
  ): Promise<QueryResult<Row>>;
  stream<Row = Record<string, unknown>>(
    sql: string,
    options?: QueryOptions,
  ): Promise<RowStream<Row>>;
  submit<Row = Record<string, unknown>>(
    sql: string,
    options?: QueryOptions,
  ): Promise<QueryHandle<Row>>;
  /**
   * Run the callback's statements in one transaction on one session: BEGIN, then COMMIT when the
   * callback's Promise fulfills or ROLLBACK when it rejects. A failed COMMIT has an unknown
   * outcome. Never retries SQL.
   */
  transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
export interface ScopedQueryClient extends QueryScope {
  close(options?: CloseOptions): Promise<void>;
}
export interface QueryClient extends ScopedQueryClient {
  asCaller(context: CallerContext): QueryScope;
}
const factories = new WeakMap<ScopedQueryClient, (scope: ConnectionScope) => QueryScope>();
const firstPollIntervalMs = 25;
const rollbackTimeoutMs = 5_000;
type Outcome<T> = { value: T } | { error: unknown };
type Log = ((event: LogEvent) => void) | undefined;

function checkSql(sql: string): void {
  if (typeof sql !== "string" || !sql.trim())
    fail("INVALID_OPTIONS", "SQL must be a nonempty string");
}

const counted = (result: QueryResult<unknown>) => ({
  queryId: result.queryId,
  rowCount: result.rowCount,
});
const streamed = (stream: RowStream<unknown>) => ({ queryId: stream.queryId });

/** Logs how an operation settled, timed from `started`; success logs what `succeeded` returns. */
async function logged<T>(
  log: Log,
  started: number,
  succeeded: ((value: T) => { queryId: string; rowCount?: number } | undefined) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!log) return operation();
  let value: T;
  try {
    value = await operation();
  } catch (error) {
    const failure = isSarError(error) ? error : undefined;
    log(
      defined({
        event: "query-failed",
        queryId: failure?.details.queryId,
        code: failure?.code ?? "QUERY_FAILED",
        errorCode: failure?.details.errorCode,
        durationMs: elapsed(started),
      }),
    );
    throw error;
  }
  const fields = succeeded?.(value);
  if (fields)
    log(
      defined({
        event: "query-succeeded",
        queryId: fields.queryId,
        durationMs: elapsed(started),
        rowCount: fields.rowCount,
      }),
    );
  return value;
}

/** Only for SDK-owned SQL text: no binds or statement parameters. */
async function control(
  lease: Lease,
  sqlText: string,
  timeoutMs: number,
  phase: string,
  signal = lease.signal,
) {
  checkAbort(signal);
  await deadline(
    new Promise<void>((resolve, reject) => {
      lease.connection.execute({
        sqlText,
        complete(error) {
          if (error) reject(error);
          else resolve();
        },
      });
    }),
    timeoutMs,
    signal,
    phase,
  );
}

const transactionAborted = () =>
  new SarError("ABORTED", "Transaction aborted", { completion: "unknown" });

/** Settles when the callback's Promise does, or as soon as the signal aborts. */
function outcome<T>(callback: () => Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    function settle(result: Outcome<T>) {
      signal.removeEventListener("abort", abort);
      resolve(result);
    }
    function abort() {
      settle({ error: transactionAborted() });
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    try {
      const result = callback();
      if (!result || typeof result.then !== "function")
        fail(
          "INVALID_OPTIONS",
          "Transaction callbacks must return a Promise and await every statement",
        );
      void result.then(
        (value) => settle({ value }),
        (error: unknown) => settle({ error }),
      );
    } catch (error) {
      settle({ error });
    }
  });
}
/** Internal composition hook; caller scopes share the parent's lifecycle, not a global registry. */
export function bindQueryScope(
  client: ScopedQueryClient,
  connections: ConnectionScope,
): QueryScope {
  return factories.get(client)!(connections);
}

/** Query helpers borrow their connection manager and never close it. */
export function createQueryClient(
  connections: ConnectionManager,
  input?: QueryClientOptions,
): QueryClient;
export function createQueryClient(
  connections: ConnectionScope,
  input?: QueryClientOptions,
): ScopedQueryClient;
export function createQueryClient(
  connections: ConnectionScope,
  input: QueryClientOptions = {},
): QueryClient | ScopedQueryClient {
  keys(input, ["results", "timeouts", "handleIdleTimeoutMs"], "query client");
  duration(input.handleIdleTimeoutMs, "handleIdleTimeoutMs");
  const options = {
    results: resultOptions(input.results),
    timeouts: timeoutOptions(input.timeouts),
  };
  const rootInternals = connectionInternals(connections);
  const handleIdleTimeoutMs = input.handleIdleTimeoutMs ?? rootInternals.handleIdleTimeoutMs;
  const leases = new Set<Lease>();
  const shutdown = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  let pendingAcquisitions = 0;
  const assertOpen = () => {
    if (closed) fail("CLIENT_CLOSED", "Client is closed");
  };
  const settingsFor = (provided?: QueryOptions) => queryOptions(options.results, provided);
  async function acquire(
    scoped: ConnectionScope,
    settings: QueryOptions = {},
    detached = false,
    transaction = false,
  ): Promise<Lease> {
    assertOpen();
    pendingAcquisitions++;
    try {
      const signalled = {
        ...settings,
        signal: AbortSignal.any([shutdown.signal, ...(settings.signal ? [settings.signal] : [])]),
      };
      const lease = await (detached
        ? detachedInternals(scoped).acquire(signalled)
        : connectionInternals(scoped).acquire(signalled, transaction));
      const release = lease.release;
      lease.release = async (reusable) => {
        try {
          await release(reusable);
        } finally {
          leases.delete(lease);
        }
      };
      leases.add(lease);
      return lease;
    } finally {
      pendingAcquisitions--;
    }
  }

  async function cleanup(lease: Lease): Promise<void> {
    lease.controller.abort();
    try {
      if (!lease.serverStatus && !lease.released) await lease.cancel?.();
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
    await lease.release();
  }

  async function begin(
    sql: string,
    caller: ConnectionScope,
    settings: ResolvedQuery,
  ): Promise<{ lease: Lease; queryId: string }> {
    const lease = await prepare(sql, caller, settings);
    try {
      return { lease, queryId: await dispatch(lease, sql, settings) };
    } catch (error) {
      await cleanup(lease).catch(() => {});
      throw error;
    }
  }

  /** Acquires a session with the output formats the result format needs. */
  async function prepare(sql: string, caller: ConnectionScope, settings: ResolvedQuery) {
    checkSql(sql);
    const lease = await acquire(caller, settings);
    const json = settings.format !== "native";
    if (json !== Boolean(lease.session.jsonFormats)) {
      try {
        await control(
          lease,
          json ? temporalSessionSql : temporalResetSql,
          settings.waitTimeoutMs ?? options.timeouts?.waitMs ?? 600_000,
          "Result format initialization",
        );
        lease.session.jsonFormats = json;
      } catch (error) {
        await lease.release().catch(() => {});
        throw operationError(
          error,
          "Result format initialization failed; user SQL was not submitted",
          { completion: "not-submitted" },
        );
      }
    }
    return lease;
  }

  function cancellation(lease: Lease, current: () => snowflake.RowStatement | undefined) {
    let cancelPromise: Promise<void> | undefined;
    lease.queryId = undefined;
    lease.serverStatus = undefined;
    lease.cancel = () =>
      (cancelPromise ??= (async () => {
        const statement = current();
        if (!statement || lease.released) return;
        try {
          await deadline(
            new Promise<void>((resolve, reject) =>
              statement.cancel((error) => (error ? reject(error) : resolve())),
            ),
            5_000,
            undefined,
            "Cancellation",
          );
        } catch (error) {
          const queryId = lease.queryId ?? statement.getQueryId();
          if (queryId) {
            const status = await deadline(lease.connection.getQueryStatus(queryId), 5_000).catch(
              () => undefined,
            );
            if (status && queryState(status) !== "pending") {
              lease.serverStatus = status;
              return;
            }
          }
          throw new SarError(
            "QUERY_FAILED",
            "Query cancellation could not be confirmed",
            { queryId, completion: "unknown", ...cancellationDetails(error, lease.mode) },
            error,
          );
        }
      })());
  }

  /**
   * Runs one statement and waits for it in a single driver request. Snowflake holds the request
   * while the statement runs and returns its first results with the response.
   */
  async function execute(
    lease: Lease,
    sql: string,
    settings: ResolvedQuery,
  ): Promise<snowflake.RowStatement> {
    const signal = AbortSignal.any([lease.signal, ...(settings.signal ? [settings.signal] : [])]);
    let statement: snowflake.RowStatement | undefined;
    cancellation(lease, () => statement);
    try {
      checkAbort(signal);
      const completed = new Promise<snowflake.RowStatement>((resolve, reject) => {
        statement = lease.connection.execute({
          ...executionOptions(settings),
          sqlText: sql,
          binds: settings.binds,
          complete(error, done) {
            if (error) reject(error);
            else resolve(done);
          },
        });
      });
      const done = await deadline(
        completed,
        settings.waitTimeoutMs ?? options.timeouts?.waitMs ?? 600_000,
        signal,
        "Query",
      );
      const queryId = done.getQueryId();
      if (!queryId) fail("QUERY_FAILED", "Driver did not return a query ID");
      lease.queryId = queryId;
      lease.serverStatus = "SUCCESS";
      return done;
    } catch (error) {
      lease.queryId ??= statement?.getQueryId();
      const failure = statementFailure(error, lease.queryId);
      if (!failure)
        throw operationError(error, "Query failed; SQL was not replayed", {
          queryId: lease.queryId,
          completion: statement ? "unknown" : "not-submitted",
        });
      lease.serverStatus = "FAILED_WITH_ERROR";
      throw failure;
    }
  }

  /** Submits one statement on a held session; the caller decides what a failure does to it. */
  async function dispatch(lease: Lease, sql: string, settings: ResolvedQuery): Promise<string> {
    const signal = AbortSignal.any([lease.signal, ...(settings.signal ? [settings.signal] : [])]);
    let statement: snowflake.RowStatement | undefined;
    cancellation(lease, () => statement);
    try {
      checkAbort(signal);
      const submission = new Promise<snowflake.RowStatement>((resolve, reject) => {
        statement = lease.connection.execute({
          ...executionOptions(settings),
          sqlText: sql,
          binds: settings.binds,
          asyncExec: true,
          complete(error, submitted) {
            if (error) reject(error);
            else resolve(submitted);
          },
        });
      });
      statement = await deadline(
        submission,
        settings.waitTimeoutMs ?? options.timeouts?.waitMs ?? 600_000,
        signal,
        "Submission",
      );
      checkAbort(signal);
      const queryId = statement.getQueryId();
      if (!queryId) fail("QUERY_FAILED", "Driver did not return a query ID");
      lease.queryId = queryId;
      return queryId;
    } catch (error) {
      throw operationError(error, "Query submission failed; SQL was not replayed", {
        queryId: statement?.getQueryId(),
        completion: statement ? "unknown" : "not-submitted",
      });
    }
  }

  async function wait(
    lease: Lease,
    settings: ResolvedQuery,
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<snowflake.RowStatement> {
    const expires =
      performance.now() +
      (timeout ?? settings.waitTimeoutMs ?? options.timeouts?.waitMs ?? 600_000);
    const activeSignal = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
    const remaining = () => {
      checkAbort(activeSignal);
      const value = expires - performance.now();
      if (value <= 0)
        throw new SarError("TIMEOUT", "Query wait deadline exceeded", {
          queryId: lease.queryId,
          completion: completion(lease),
        });
      return value;
    };
    const maxInterval = settings.pollIntervalMs ?? 1_000;
    let interval = Math.min(firstPollIntervalMs, maxInterval);
    for (;;) {
      const time = remaining();
      const status = await deadline(
        lease.connection.getQueryStatus(lease.queryId!),
        time,
        activeSignal,
        "Query status",
        expires,
      );
      const state = queryState(status);
      if (state !== "pending") lease.serverStatus = status;
      if (state === "failed")
        throw await failedQuery(
          lease.connection,
          lease.queryId!,
          Math.min(5_000, Math.max(1, expires - performance.now())),
          activeSignal,
        );
      if (state === "succeeded") {
        const fetchTime = remaining();
        return deadline(
          fetchResult(lease.connection, lease.queryId!, executionOptions(settings)),
          fetchTime,
          activeSignal,
          "Result fetch",
          expires,
        );
      }
      const pauseTime = remaining();
      await deadline(
        pause(Math.min(interval, pauseTime)),
        pauseTime,
        activeSignal,
        "Query wait",
        expires,
      );
      interval = Math.min(interval * 2, maxInterval);
    }
  }

  function rows<Row>(
    lease: Lease,
    statement: snowflake.RowStatement,
    settings: ResolvedQuery,
    releaseOnClose = true,
    onRow?: (row: unknown) => void,
  ): RowStream<Row> {
    checkAbort(lease.signal);
    const queryId = lease.queryId!;
    const columns = metadata(statement, settings);
    const readable = statement.streamRows();
    const signal = AbortSignal.any([lease.signal, ...(settings.signal ? [settings.signal] : [])]);
    const timeout = settings.consumeTimeoutMs ?? options.timeouts?.consumeMs ?? 120_000;
    const expires = performance.now() + timeout;
    const timeoutError = new SarError("TIMEOUT", "Result consumption deadline exceeded", {
      queryId,
      completion: "succeeded",
    });
    let finished = false;
    let iterated = false;
    let streamError: unknown;
    let closePromise: Promise<void> | undefined;
    let exhausted = false;
    const close = () =>
      (closePromise ??= releaseOnClose
        ? lease.release(exhausted && !streamError && !signal.aborted)
        : Promise.resolve().then(() => lease.dispose?.()));
    const abort = () => {
      streamError = new SarError("ABORTED", "Result consumption aborted", {
        queryId,
        completion: "succeeded",
      });
      readable.destroy();
      void close().catch(() => {});
    };
    const timer = setTimeout(
      () => {
        streamError = timeoutError;
        readable.destroy();
        void close().catch(() => {});
      },
      Math.max(0, expires - performance.now()),
    );
    timer.unref();
    const previousDispose = lease.dispose;
    lease.dispose = () => {
      previousDispose?.();
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      readable.destroy();
    };
    readable.on("error", (error) => {
      streamError ??= error;
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      queryId,
      columns,
      close,
      async *[Symbol.asyncIterator]() {
        if (iterated) fail("INVALID_OPTIONS", "Row stream can only be consumed once");
        iterated = true;
        const iterator = readable[Symbol.asyncIterator]();
        let failed = false;
        try {
          for (;;) {
            if (streamError) throw streamError;
            checkAbort(signal);
            if (finished) return;
            const remaining = expires - performance.now();
            if (remaining <= 0) throw timeoutError;
            const item = await deadline(
              iterator.next(),
              remaining,
              signal,
              "Result consumption",
              expires,
              timeoutError,
            );
            if (streamError) throw streamError;
            checkAbort(signal);
            if (item.done) {
              exhausted = true;
              return;
            }
            if (finished) return;
            onRow?.(item.value);
            const row = convertRow(item.value, columns, settings) as Row;
            checkAbort(signal);
            if (performance.now() >= expires) throw timeoutError;
            yield row;
          }
        } catch (error) {
          failed = true;
          const failure = streamError ?? error;
          throw operationError(failure, "Result consumption failed", {
            queryId,
            completion: "succeeded",
          });
        } finally {
          if (failed) await close().catch(() => {});
          // A discarded session's logout doesn't hold back read rows; the lease stays tracked
          // until it settles. Pooled sessions finish their reset so the next query can reuse them.
          else if (exhausted && releaseOnClose && !lease.pooled) void close().catch(() => {});
          else await close();
        }
      },
    };
  }

  async function materialize<Row>(
    lease: Lease,
    statement: snowflake.RowStatement,
    settings: ResolvedQuery,
    releaseOnClose = true,
  ): Promise<QueryResult<Row>> {
    let summary: unknown;
    const stream = rows<Row>(
      lease,
      statement,
      settings,
      releaseOnClose,
      isDml(statement) ? (row) => (summary ??= row) : undefined,
    );
    const output: Row[] = [];
    let bytes = 0;
    for await (const row of stream) {
      bytes += rowBytes(row);
      if (output.length >= settings.maxRows || bytes > settings.maxBytes)
        throw new SarError(
          "RESULT_LIMIT_EXCEEDED",
          "Result exceeds configured materialization limits; use stream or narrower SQL",
          { queryId: lease.queryId, completion: "succeeded" },
        );
      output.push(row);
    }
    const affectedRows = dmlCount(summary, stream.columns);
    return {
      rows: output,
      queryId: stream.queryId,
      columns: stream.columns,
      rowCount: output.length,
      ...(affectedRows === undefined ? {} : { affectedRows }),
    };
  }

  async function transact<T>(
    caller: ConnectionScope,
    log: Log,
    callback: (tx: Transaction) => Promise<T>,
    provided?: TransactionOptions,
  ): Promise<T> {
    if (typeof callback !== "function") fail("INVALID_OPTIONS", "transaction requires a callback");
    const settings = transactionOptions(options.results, provided);
    const waitMs = options.timeouts?.waitMs ?? 600_000;
    const lease = await acquire(caller, settings, false, true);
    try {
      // Result fetches read session formats; setting them inside the transaction could commit it.
      const json = settings.format !== "native";
      if (json !== Boolean(lease.session.jsonFormats)) {
        await control(
          lease,
          json ? temporalSessionSql : temporalResetSql,
          waitMs,
          "Result format initialization",
        );
        lease.session.jsonFormats = json;
      }
      await control(lease, "BEGIN", waitMs, "Transaction start");
    } catch (error) {
      await lease.release().catch(() => {});
      throw operationError(error, "Transaction start failed; user SQL was not submitted", {
        completion: "not-submitted",
      });
    }
    const stop = new AbortController();
    let ended = false;
    let uncertain = false;
    let pending = 0;
    let tail = Promise.resolve();
    async function run<Row>(sql: string, statement: ResolvedQuery): Promise<QueryResult<Row>> {
      if (ended) fail("INVALID_OPTIONS", "Transaction has ended");
      if (uncertain)
        throw new SarError(
          "QUERY_FAILED",
          "A previous statement may still be running; the transaction cannot continue",
          { completion: "not-submitted" },
        );
      try {
        await dispatch(lease, sql, statement);
        const fetched = await wait(lease, statement, statement.signal);
        return await materialize<Row>(lease, fetched, statement, false);
      } catch (error) {
        if (!lease.serverStatus)
          await lease.cancel?.().catch(() => {
            uncertain = true;
          });
        throw operationError(error, "Query or result consumption failed", {
          queryId: lease.queryId,
          completion: completion(lease),
        });
      } finally {
        lease.cancel = undefined;
        lease.dispose = undefined;
      }
    }
    const tx: Transaction = Object.freeze({
      query<Row = Record<string, unknown>>(sql: string, input?: TransactionQueryOptions) {
        return logged(log, performance.now(), counted, async () => {
          if (ended) fail("INVALID_OPTIONS", "Transaction has ended");
          checkSql(sql);
          const resolved = transactionQueryOptions(settings, input);
          const statement = {
            ...resolved,
            signal: AbortSignal.any([stop.signal, ...(resolved.signal ? [resolved.signal] : [])]),
          };
          const turn = tail;
          let done!: () => void;
          tail = new Promise<void>((resolve) => {
            done = resolve;
          });
          pending++;
          try {
            await turn;
            return await run<Row>(sql, statement);
          } finally {
            pending--;
            done();
          }
        });
      },
    });
    const result = await outcome(() => callback(tx), lease.signal);
    ended = true;
    const abandoned = pending > 0;
    if ("error" in result || abandoned) stop.abort();
    await tail;
    const aborted = lease.signal.aborted;
    if ("value" in result && !abandoned && !uncertain && !aborted) {
      try {
        await control(lease, "COMMIT", waitMs, "Commit");
      } catch (error) {
        await lease.release().catch(() => {});
        throw new SarError(
          "QUERY_FAILED",
          "Transaction commit failed; its outcome is unknown",
          { completion: "unknown", ...snowflakeDetails(error) },
          error,
        );
      }
      // Rejecting would invite repeating committed work; a failed cleanup discards the session.
      await lease.release(true).catch(() => {});
      return result.value;
    }
    const failure =
      "error" in result
        ? result.error
        : abandoned
          ? new SarError("INVALID_OPTIONS", "Transaction callbacks must await every statement")
          : aborted
            ? transactionAborted()
            : new SarError(
                "QUERY_FAILED",
                "Transaction was not committed because a statement may still be running",
                { completion: "unknown" },
              );
    // In the aggregate client the manager's shutdown can abort the session a moment before this
    // client's own shutdown signal, so an abort the transaction's signal didn't cause is shutdown.
    const shuttingDown = shutdown.signal.aborted || (aborted && !settings.signal?.aborted);
    // Transaction control must not run beside a statement that may still be executing. Shutdown
    // logs sessions out; other aborts roll back because a caller session's logout can wait.
    const rolledBack =
      !uncertain &&
      !shuttingDown &&
      !lease.released &&
      (await control(lease, "ROLLBACK", rollbackTimeoutMs, "Rollback", shutdown.signal).then(
        () => true,
        () => false,
      ));
    await lease.release(rolledBack && !aborted).catch(() => {});
    throw failure;
  }

  function scope(caller: ConnectionScope): QueryScope {
    const log = connectionInternals(caller).log;
    async function submit<Row>(sql: string, provided?: QueryOptions): Promise<QueryHandle<Row>> {
      const started = performance.now();
      // The handle's result() logs success.
      const { settings, lease, queryId } = await logged(log, started, undefined, async () => {
        const settings = settingsFor(provided);
        return { settings, ...(await begin(sql, caller, settings)) };
      });
      let cached: Promise<QueryResult<Row>> | undefined;
      let cancelled = false;
      let cleanupPromise: Promise<void> | undefined;
      const dispose = () => (cleanupPromise ??= Promise.resolve().then(() => cleanup(lease)));
      const idle = setTimeout(() => {
        cancelled = true;
        void dispose().catch(() => {});
      }, handleIdleTimeoutMs);
      idle.unref();
      const abort = () => {
        void dispose().catch(() => {});
      };
      lease.dispose = () => {
        clearTimeout(idle);
        lease.signal.removeEventListener("abort", abort);
      };
      lease.signal.addEventListener("abort", abort, { once: true });
      if (lease.signal.aborted) abort();
      return {
        queryId,
        async status() {
          if (lease.serverStatus) return lease.serverStatus;
          if (cancelled) fail("QUERY_FAILED", "Query handle has expired or was cancelled");
          checkAbort(lease.signal);
          if (lease.released) fail("QUERY_FAILED", "Query session is no longer available");
          try {
            const status = await deadline(
              lease.connection.getQueryStatus(queryId),
              30_000,
              lease.signal,
              "Query status",
            );
            if (queryState(status) !== "pending") lease.serverStatus = status;
            return status;
          } catch (error) {
            throw operationError(error, "Query status unavailable", {
              queryId,
              completion: completion(lease),
            });
          }
        },
        result(waitOptions = {}) {
          keys(waitOptions, ["signal", "waitTimeoutMs"], "result");
          signalOption(waitOptions.signal);
          duration(waitOptions.waitTimeoutMs, "waitTimeoutMs");
          if (cancelled)
            return Promise.reject(
              new SarError("QUERY_FAILED", "Query handle has expired or was cancelled", {
                queryId,
                completion: completion(lease),
              }),
            );
          if (!cached) {
            clearTimeout(idle);
            const signal = AbortSignal.any([
              lease.signal,
              ...(waitOptions.signal ? [waitOptions.signal] : []),
            ]);
            cached = logged(log, started, counted, async () => {
              try {
                const statement = await wait(lease, settings, signal, waitOptions.waitTimeoutMs);
                checkAbort(signal);
                return await materialize<Row>(lease, statement, { ...settings, signal });
              } catch (error) {
                await dispose().catch(() => {});
                throw operationError(error, "Query or result consumption failed", {
                  queryId,
                  completion: completion(lease),
                });
              }
            });
          }
          return cached;
        },
        async cancel() {
          clearTimeout(idle);
          cancelled = true;
          await dispose();
        },
      };
    }
    const detached = createDetachedScope(caller, {
      assertOpen,
      acquire: (settings) => acquire(caller, settings, true),
      results: options.results,
      materialize: (lease, statement, settings) => materialize(lease, statement, settings, false),
      stream: (lease, statement, settings) => rows(lease, statement, settings),
    });
    return Object.freeze({
      ...detached,
      pollQuery<Row>(reference: QueryReference, provided?: PollQueryOptions) {
        return logged(
          log,
          performance.now(),
          (outcome) => (outcome.status === "complete" ? counted(outcome.result) : undefined),
          () => detached.pollQuery<Row>(reference, provided),
        );
      },
      streamQuery<Row>(reference: QueryReference, provided?: PollQueryOptions) {
        return logged(
          log,
          performance.now(),
          (outcome) => (outcome.status === "complete" ? streamed(outcome.stream) : undefined),
          () => detached.streamQuery<Row>(reference, provided),
        );
      },
      submit,
      query<Row>(sql: string, provided?: QueryOptions) {
        return logged(log, performance.now(), counted, async () => {
          const settings = settingsFor(provided);
          const lease = await prepare(sql, caller, settings);
          try {
            return await materialize<Row>(lease, await execute(lease, sql, settings), settings);
          } catch (error) {
            await cleanup(lease).catch(() => {});
            throw operationError(error, "Query or result consumption failed", {
              queryId: lease.queryId,
              completion: completion(lease),
            });
          }
        });
      },
      stream<Row>(sql: string, provided?: QueryOptions) {
        return logged(log, performance.now(), streamed, async () => {
          const settings = settingsFor(provided);
          const lease = await prepare(sql, caller, settings);
          try {
            return rows<Row>(lease, await execute(lease, sql, settings), settings);
          } catch (error) {
            await cleanup(lease).catch(() => {});
            throw operationError(error, "Stream failed", {
              queryId: lease.queryId,
              completion: completion(lease),
            });
          }
        });
      },
      transaction<T>(callback: (tx: Transaction) => Promise<T>, provided?: TransactionOptions) {
        return transact(caller, log, callback, provided);
      },
    });
  }
  const client = Object.freeze({
    ...scope(connections),
    ...("asCaller" in connections
      ? {
          asCaller(context: CallerContext) {
            assertOpen();
            return scope((connections as ConnectionManager).asCaller(context));
          },
        }
      : {}),
    close(closeOptions: CloseOptions = {}) {
      if (closing) return closing;
      keys(closeOptions, ["timeoutMs"], "close");
      duration(closeOptions.timeoutMs, "close timeout");
      closed = true;
      closing = (async () => {
        const until =
          performance.now() + (closeOptions.timeoutMs ?? options.timeouts?.closeMs ?? 10_000);
        while ((leases.size || pendingAcquisitions) && performance.now() < until)
          await pause(Math.min(10, Math.max(1, until - performance.now())));
        const timedOut = leases.size > 0 || pendingAcquisitions > 0;
        const outstanding = [...leases];
        shutdown.abort();
        const released = await Promise.allSettled(outstanding.map(cleanup));
        if (timedOut)
          throw new SarError(
            "SHUTDOWN_TIMEOUT",
            "Shutdown grace period exceeded; server outcome may be unknown",
            { queryId: outstanding[0]?.queryId, completion: "unknown" },
          );
        const failure = released.find((result) => result.status === "rejected");
        if (failure?.status === "rejected")
          throw operationError(failure.reason, "Shutdown cleanup failed");
      })();
      return closing;
    },
  });
  factories.set(client, scope);
  return client;
}
