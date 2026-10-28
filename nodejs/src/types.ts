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
import type { ConnectionOptionsProvider } from "./auth-client.js";

/** Node driver bind values, passed through without SQL interpolation. */
export type Binds = snowflake.Binds;
/** Compatible injected driver. No module-global configure calls are made. */
export interface DriverModule {
  createConnection(options: snowflake.ConnectionOptions): snowflake.Connection;
}
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
/** Runs statements on the transaction's session one at a time, in call order. */
export interface Transaction {
  /** Materialized result, as from query(). Rejects once the transaction has ended. */
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: TransactionQueryOptions,
  ): Promise<QueryResult<Row>>;
}
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
/** Structural interface implemented by Web Headers and Next.js request headers. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}
/** Exactly one source is required. A supplied empty token is invalid. */
export type CallerContext =
  { headers: HeaderReader; token?: never } | { token: string; headers?: never };
/** Username and password are resolved together from a single source. */
export interface PasswordSecret {
  username: string;
  password: string;
}
/** Secret source may return undefined only when absent, not when revoked. */
export interface SecretProvider {
  readonly id: string;
  resolve(
    name: string,
    type: "string" | "password" | "accessToken",
  ): Promise<string | PasswordSecret | undefined>;
}
/** No SQL authentication is performed by these methods. */
export interface Secrets {
  getString(name: string): Promise<string>;
  getPassword(name: string): Promise<PasswordSecret>;
  getAccessToken(name: string): Promise<string>;
}
/**
 * Events never contain SQL, binds, rows, credentials, profile values, file paths, or error
 * messages.
 */
export interface LogEvent {
  event: string;
  queryId?: string;
  /** The SDK error code. */
  code?: string;
  /** Whole milliseconds, including session acquisition. */
  durationMs?: number;
  /** Returned rows, as in QueryResult. */
  rowCount?: number;
  /** Snowflake's numeric error code. */
  errorCode?: string;
  mode?: "owner" | "caller";
}
export interface ClientDiagnostics {
  sessionMode: "isolated" | "reusable";
  activeConnections: number;
  queuedOperations: number;
  idleConnections: number;
  physicalConnections: number;
}
/** Reuse requires application-specific restoration of all SQL session state. */
export type PoolOptions = {
  maxConnections?: number;
  maxQueue?: number;
  acquireTimeoutMs?: number;
  handleIdleTimeoutMs?: number;
} & (
  | {
      mode?: "isolated";
      reset?: never;
      idleTimeoutMs?: never;
      maxLifetimeMs?: never;
      resetTimeoutMs?: never;
    }
  | {
      mode: "reusable";
      reset: (connection: snowflake.Connection) => Promise<void>;
      idleTimeoutMs?: number;
      maxLifetimeMs?: number;
      resetTimeoutMs?: number;
    }
);
export type CloseOptions = { timeoutMs?: number };
/** A scoped native-driver interface, with no identity switch or parent shutdown. */
export interface ConnectionScope {
  withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>): Promise<T>;
}
export interface ConnectionManager extends ConnectionScope {
  asCaller(context: CallerContext): ConnectionScope;
  connect(): Promise<void>;
  diagnostics(): Promise<ClientDiagnostics>;
  close(options?: CloseOptions): Promise<void>;
}
export type ConnectionManagerOptions = Pick<
  SarClientOptions,
  "pool" | "timeouts" | "driver" | "logger"
>;
export type QueryClientOptions = Pick<SarClientOptions, "results" | "timeouts"> & {
  handleIdleTimeoutMs?: number;
};
export type QueryScope = Pick<CallerClient, "query" | "stream" | "submit" | "transaction"> &
  DetachedQueryScope;
export interface ScopedQueryClient extends QueryScope {
  close(options?: CloseOptions): Promise<void>;
}
export interface QueryClient extends ScopedQueryClient {
  asCaller(context: CallerContext): QueryScope;
}
export type FetchClientOptions = Pick<SarClientOptions, "timeouts">;
/** Standard fetch options plus a per-request deadline. */
export type FetchInit = RequestInit & {
  /** Deadline for this request, including reading its body. Overrides `timeouts.httpMs`. */
  timeoutMs?: number;
};
export interface FetchScope {
  fetch(path: string, init?: FetchInit): Promise<Response>;
}
export interface FetchClient extends FetchScope {
  asCaller(context: CallerContext): FetchScope;
  close(): Promise<void>;
}
export type SecretsOptions = NonNullable<SarClientOptions["secrets"]>;
export interface SecretsClient extends Secrets {
  close(): Promise<void>;
}
/** Options are checked at runtime for JavaScript callers as well. */
export type SarClientOptions = {
  /**
   * Borrowed native-options provider from createConnectionOptions; configure it with explicit
   * connection options. Without it, work that needs a Snowflake connection fails.
   */
  connectionOptions?: ConnectionOptionsProvider;
  pool?: PoolOptions;
  timeouts?: {
    waitMs?: number;
    consumeMs?: number;
    closeMs?: number;
    /** Default fetch() deadline, including reading the response body. Default: 120 seconds. */
    httpMs?: number;
  };
  results?: ResultOptions;
  secrets?: { directory?: string; envPrefix?: string; providers?: readonly SecretProvider[] };
  driver?: DriverModule;
  logger?: (event: LogEvent) => void;
};
/** Caller views cannot read app secrets or close the parent client. */
export interface CallerClient extends DetachedQueryScope {
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
  withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>): Promise<T>;
  /**
   * Authenticated fetch to an account-relative path, retaining this view's identity.
   * Redirects are rejected; consume or cancel the returned response body.
   * Throws AUTH_NOT_SUPPORTED_FOR_REST when the credential cannot authorize HTTP.
   */
  fetch(path: string, init?: FetchInit): Promise<Response>;
}
/** A lazy, independent server-side client. Call close during controlled shutdown. */
export interface SarClient extends CallerClient {
  /** Open and release a temporary session; does not keep a warm connection. */
  connect(): Promise<void>;
  /** Synchronous, connection-free caller view. Input must come from trusted ingress. */
  asCaller(context: CallerContext): CallerClient;
  /** Await all work inside the callback; never retain or destroy the supplied connection. */
  withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>): Promise<T>;
  readonly secrets: Secrets;
  diagnostics(): Promise<ClientDiagnostics>;
  /** Stop new work; timeoutMs is the SQL grace period, followed by bounded cleanup. HTTP aborts immediately. */
  close(options?: { timeoutMs?: number }): Promise<void>;
}
