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
import type { ConnectionScope, LogEvent, QueryOptions } from "./types.js";
import type { SessionState } from "./session-store.js";
import { fail } from "./errors.js";

export type Lease = {
  connection: snowflake.Connection;
  controller: AbortController;
  signal: AbortSignal;
  release(reusable?: boolean): Promise<void>;
  cancel?: () => Promise<void>;
  dispose?: () => void;
  released: boolean;
  /** A successful release keeps the session for a later borrower instead of discarding it. */
  pooled: boolean;
  readonly mode: "owner" | "caller";
  session: SessionState;
  queryId?: string;
  serverStatus?: string;
};
export const completion = (lease: Lease) =>
  lease.serverStatus === "SUCCESS"
    ? ("succeeded" as const)
    : lease.serverStatus
      ? ("failed" as const)
      : ("unknown" as const);
type ScopeInternals = {
  /** A transaction's lease excludes other work for the same caller context until it's released. */
  acquire(settings?: QueryOptions, transaction?: boolean): Promise<Lease>;
  handleIdleTimeoutMs: number;
  /** The client's logger, which never throws. */
  log?: (event: LogEvent) => void;
  detached?: {
    readonly mode: "owner" | "caller";
    acquire(settings?: QueryOptions): Promise<Lease>;
  };
};
// Non-enumerable and immutable, but shared by mixed ESM/CJS consumers. No global registry.
const scopeKey = Symbol.for("@snowflake/sar-sdk/connection-scope/v1");
export function registerScope(scope: ConnectionScope, internals: ScopeInternals): void {
  if (internals.detached) Object.freeze(internals.detached);
  Object.defineProperty(scope, scopeKey, { value: Object.freeze(internals) });
}
export function connectionInternals(scope: ConnectionScope) {
  const found = scope && (scope as unknown as Record<symbol, ScopeInternals>)[scopeKey];
  if (!found || typeof found.acquire !== "function")
    fail("INVALID_OPTIONS", "Query helpers require a scope from createConnectionManager");
  return found;
}

export function detachedInternals(scope: ConnectionScope) {
  const found = connectionInternals(scope).detached;
  if (!found || typeof found.acquire !== "function")
    fail("DETACHED_QUERY_NOT_SUPPORTED", "Connection scope does not support detached queries");
  return found;
}
