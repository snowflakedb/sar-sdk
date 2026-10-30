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
  snapshotProvider,
  optionsScope,
  unconfiguredOptions,
} from "../connection-options/connection-options.js";
import type { ConnectionOptionsProvider } from "../connection-options/connection-options.js";
import {
  duration,
  fail,
  isSarError,
  keys,
  nextSteps,
  operationError,
  SarError,
  snowflakeDetails,
} from "../core/errors.js";
import {
  Budget,
  checkAbort,
  deadline,
  elapsed,
  pause,
  safeLogger,
  type CloseOptions,
  type LogEvent,
} from "../core/lifecycle.js";
import type { TimeoutOptions } from "../core/timeouts.js";
import {
  completion,
  registerScope,
  type ConnectionScope,
  type Lease,
  type SessionRequest,
} from "./lease.js";
import {
  SessionStore,
  type DriverModule,
  type PoolOptions,
  type Resource,
  type SessionKind,
} from "./session-store.js";
import { connectionOptions } from "./connection-manager-options.js";
import type { CallerContext } from "../connection-options/caller.js";

export type { ConnectionScope } from "./lease.js";
export type { DriverModule, DriverPoolOptions, PoolOptions } from "./session-store.js";

export interface ClientDiagnostics {
  sessionMode: "isolated" | "reusable";
  activeConnections: number;
  queuedOperations: number;
  idleConnections: number;
  physicalConnections: number;
}
export interface ConnectionManager extends ConnectionScope {
  asCaller(context: CallerContext): ConnectionScope;
  connect(): Promise<void>;
  diagnostics(): Promise<ClientDiagnostics>;
  close(options?: CloseOptions): Promise<void>;
}
export type ConnectionManagerOptions = {
  pool?: PoolOptions;
  timeouts?: TimeoutOptions;
  driver?: DriverModule;
  logger?: (event: LogEvent) => void;
};

const interactive = [
  "EXTERNALBROWSER",
  "USERNAME_PASSWORD_MFA",
  "OAUTH_AUTHORIZATION_CODE",
  "OAUTH_CLIENT_CREDENTIALS",
];

/** Lazy native-driver access. Components using this manager borrow it, never own it. */
export function createConnectionManager(
  provider?: ConnectionOptionsProvider,
  input: ConnectionManagerOptions = {},
): ConnectionManager {
  const options = connectionOptions(input);
  const auth = snapshotProvider(provider ?? unconfiguredOptions);
  const log = safeLogger(options.logger);
  const ownerOptions = optionsScope(auth);
  const budget = new Budget(options.pool?.maxConnections ?? 10, options.pool?.maxQueue ?? 100);
  const store = new SessionStore(options.pool);
  const shutdown = new AbortController();
  const leases = new Set<Lease>();
  let driverPromise: Promise<DriverModule> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let loginTail = Promise.resolve();
  const assertOpen = () => {
    if (closed) fail("CLIENT_CLOSED", "Connection manager is closed");
  };
  const loadDriver = () =>
    (driverPromise ??= options.driver
      ? Promise.resolve(options.driver)
      : import("snowflake-sdk").then((module) => module.default));
  // On SPCS, Snowflake gives every login with the same caller token one session, so a caller
  // transaction would also contain any other statement for that token. Count the work per token.
  const callerWork = new Map<string, { active: number; transaction: boolean }>();
  function claim(credentials: ReturnType<typeof optionsScope>, transaction: boolean): () => void {
    const key = credentials.contextKey;
    if (key === undefined) return () => {};
    const work = callerWork.get(key) ?? { active: 0, transaction: false };
    if (work.transaction)
      throw new SarError(
        "INVALID_OPTIONS",
        "A transaction is open for this caller context; on SPCS, other statements for it would run inside the transaction",
        { nextStep: nextSteps.callerTransactionOpen },
      );
    if (transaction && work.active > 0)
      throw new SarError(
        "INVALID_OPTIONS",
        "Other work for this caller context is still running; on SPCS, it would share the transaction's session",
        { nextStep: nextSteps.callerWorkRunning },
      );
    work.active++;
    if (transaction) work.transaction = true;
    callerWork.set(key, work);
    let claimed = true;
    return () => {
      if (!claimed) return;
      claimed = false;
      work.active--;
      if (transaction) work.transaction = false;
      if (work.active === 0) callerWork.delete(key);
    };
  }
  async function acquire(
    credentials: ReturnType<typeof optionsScope>,
    settings: SessionRequest = {},
    detached = false,
    transaction = false,
  ): Promise<Lease> {
    assertOpen();
    const unclaim = claim(credentials, transaction);
    const releaseBudget = await budget
      .acquire(
        settings.acquireTimeoutMs ?? options.pool?.acquireTimeoutMs ?? 30_000,
        settings.signal,
      )
      .catch((error: unknown) => {
        unclaim();
        throw error;
      });
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      shutdown.signal,
      ...(settings.signal ? [settings.signal] : []),
    ]);
    let resource: Resource | undefined;
    let releaseSlot: (() => void) | undefined;
    let abandoned = false;
    const timeout = settings.authTimeoutMs ?? 120_000;
    const expires = performance.now() + timeout;
    const deferLogout = credentials.mode === "caller" && !detached;
    const kind: SessionKind = detached ? "detached" : deferLogout ? "caller" : "owned";
    const checkAuthentication = () => {
      if (abandoned) fail("ABORTED", "Authentication was abandoned");
      checkAbort(signal);
      if (performance.now() >= expires) fail("TIMEOUT", "Authentication deadline exceeded");
    };
    const nativeOptions = (resolved: snowflake.ConnectionOptions) => ({
      ...resolved,
      ...(settings.warehouse ? { warehouse: settings.warehouse } : {}),
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
      serverSessionKeepAlive: detached,
    });
    /** Interactive logins can prompt the user, so they run one at a time. */
    const login = async <T>(resolved: snowflake.ConnectionOptions, run: () => Promise<T>) => {
      if (!interactive.includes(resolved.authenticator?.toUpperCase() ?? "")) return run();
      const turn = loginTail.then(run, run);
      loginTail = turn.then(
        () => {},
        () => {},
      );
      return turn;
    };
    const pending = (async () => {
      checkAuthentication();
      const started = performance.now();
      const driver = await loadDriver();
      checkAuthentication();
      const partition = () =>
        store.partition(credentials, settings.warehouse, kind, driver.createPool);
      if (store.counts(kind)) resource = await store.borrow(partition());
      checkAuthentication();
      if (!resource) {
        releaseSlot = await store.reserve(partition(), timeout, signal);
        checkAuthentication();
        if (kind === "caller" && !store.counts(kind)) {
          resource = await store.borrow(partition(), releaseSlot);
          if (resource) releaseSlot = undefined;
          checkAuthentication();
        }
      }
      if (!resource) {
        const resolved = nativeOptions(credentials.options());
        checkAuthentication();
        const opened = await login(resolved, () => {
          checkAuthentication();
          const current = partition();
          const slot = releaseSlot!;
          releaseSlot = undefined;
          return store.open(current, resolved, slot);
        });
        resource = opened.resource;
        // Every detached submission and status check logs in, so these would add a line per poll.
        if (opened.opened && !detached)
          log?.({ event: "session-opened", mode: credentials.mode, durationMs: elapsed(started) });
      }
      const current = resource.connection;
      const ownedResource = resource;
      let released: Promise<void> | undefined;
      const lease: Lease = {
        connection: current,
        controller,
        signal,
        released: false,
        pooled: !detached && (options.pool?.mode === "reusable" || deferLogout),
        mode: credentials.mode,
        session: ownedResource.state,
        release(reusable = false) {
          released ??= Promise.resolve().then(async () => {
            lease.released = true;
            try {
              lease.dispose?.();
              await store.release(ownedResource, reusable && !closed && !detached, signal);
            } catch (error) {
              throw operationError(error, "Session cleanup failed", {
                queryId: lease.queryId,
                completion: completion(lease),
              });
            } finally {
              leases.delete(lease);
              releaseBudget();
              unclaim();
            }
          });
          return released;
        },
      };
      leases.add(lease);
      return lease;
    })();
    try {
      const lease = await deadline(pending, timeout, signal, "Authentication", expires);
      checkAbort(signal);
      return lease;
    } catch (error) {
      abandoned = true;
      void pending
        .then(
          (late) => late.release(),
          async () => {
            if (resource) await store.discard(resource).catch(() => {});
            else releaseSlot?.();
            releaseBudget();
            unclaim();
          },
        )
        .catch(() => {});
      if (isSarError(error)) throw error;
      throw new SarError(
        "AUTH_FAILED",
        "Snowflake authentication failed while opening the configured connection",
        { completion: "not-submitted", ...snowflakeDetails(error) },
        error,
      );
    }
  }
  function internals(credentials: ReturnType<typeof optionsScope>) {
    return {
      acquire: (settings?: SessionRequest, transaction?: boolean) =>
        acquire(credentials, settings, false, transaction),
      handleIdleTimeoutMs: options.pool?.handleIdleTimeoutMs ?? 300_000,
      log,
      detached: {
        mode: credentials.mode,
        acquire: (settings?: SessionRequest) => acquire(credentials, settings, true),
      },
    };
  }
  function scope(credentials: ReturnType<typeof optionsScope>): ConnectionScope {
    const scoped = {
      async withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>) {
        if (typeof callback !== "function")
          fail("INVALID_OPTIONS", "withConnection requires a callback");
        const lease = await acquire(credentials);
        let failed = false;
        try {
          checkAbort(lease.signal);
          const result = callback(lease.connection);
          if (!result || typeof result.then !== "function")
            fail(
              "INVALID_OPTIONS",
              "Native callbacks must return a Promise and await all driver work",
            );
          return await result;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (failed) await lease.release().catch(() => {});
          else await lease.release(true);
        }
      },
    };
    registerScope(scoped, internals(credentials));
    return Object.freeze(scoped);
  }
  const owner = scope(ownerOptions);
  const manager: ConnectionManager = {
    ...owner,
    asCaller(context: CallerContext) {
      assertOpen();
      const credentials = optionsScope(auth, context);
      // Reusable sessions are keyed by scope, so owner-mode views share the owner's.
      return scope(credentials.mode === "owner" ? ownerOptions : credentials);
    },
    async connect() {
      const lease = await acquire(ownerOptions);
      await lease.release();
    },
    async withConnection<T>(
      callback: (connection: snowflake.Connection) => Promise<T>,
      extra?: unknown,
    ): Promise<T> {
      assertOpen();
      if (typeof callback !== "function" || extra !== undefined)
        fail(
          "INVALID_OPTIONS",
          "withConnection takes only a callback; use asCaller({ headers }).withConnection(callback) for caller identity",
        );
      return owner.withConnection(callback);
    },
    async diagnostics() {
      return {
        sessionMode: options.pool?.mode ?? "isolated",
        activeConnections: budget.active,
        queuedOperations: budget.queued,
        idleConnections: store.idle,
        physicalConnections: store.slots.active,
      };
    },
    close(settings: CloseOptions = {}) {
      if (closing) return closing;
      keys(settings, ["timeoutMs"], "close");
      duration(settings.timeoutMs, "close timeout");
      closed = true;
      budget.close();
      const idleClosed = store.closeIdle();
      void idleClosed.catch(() => {});
      closing = (async () => {
        const until =
          performance.now() + (settings.timeoutMs ?? options.timeouts?.closeMs ?? 10_000);
        while (budget.active && performance.now() < until)
          await pause(Math.min(10, Math.max(1, until - performance.now())));
        const timedOut = budget.active > 0;
        const outstanding = [...leases];
        shutdown.abort();
        const results = await Promise.allSettled(
          outstanding.map(async (lease) => {
            try {
              if (!lease.serverStatus && !lease.released) await lease.cancel?.();
            } finally {
              await lease.release();
            }
          }),
        );
        try {
          await idleClosed;
        } catch (error) {
          throw operationError(error, "Idle session cleanup failed");
        }
        if (timedOut)
          throw new SarError(
            "SHUTDOWN_TIMEOUT",
            "Shutdown grace period exceeded; server outcome may be unknown",
            { queryId: outstanding[0]?.queryId, completion: "unknown" },
          );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected")
          throw operationError(failure.reason, "Shutdown cleanup failed");
      })();
      return closing;
    },
  };
  registerScope(manager, internals(ownerOptions));
  return Object.freeze(manager);
}
