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

import { snapshotProvider, unconfiguredOptions } from "./connection-options/connection-options.js";
import { callerToken } from "./connection-options/caller.js";
import { createConnectionManager } from "./connection-manager/connection-manager.js";
import { createFetchClient } from "./fetch-client/fetch-client.js";
import { createQueryClient, bindQueryScope } from "./query-client/query-client.js";
import { createSecrets } from "./secrets-client/secrets-client.js";
import { timeoutOptions, type TimeoutOptions } from "./core/timeouts.js";
import { duration, fail, keys } from "./core/errors.js";
import type snowflake from "snowflake-sdk";
import type { ConnectionOptionsProvider } from "./connection-options/connection-options.js";
import type { CallerContext } from "./connection-options/caller.js";
import type {
  ClientDiagnostics,
  PoolOptions,
  DriverModule,
  ConnectionScope,
} from "./connection-manager/connection-manager.js";
import type { CloseOptions, LogEvent } from "./core/lifecycle.js";
import type { FetchScope } from "./fetch-client/fetch-client.js";
import type { ResultOptions } from "./query-client/query-options.js";
import type { QueryScope } from "./query-client/query-client.js";
import type { Secrets, SecretsOptions } from "./secrets-client/secrets-client.js";

/** Options are checked at runtime for JavaScript callers as well. */
export type SarClientOptions = {
  /**
   * Borrowed native-options provider from createConnectionOptions; configure it with explicit
   * connection options. Without it, work that needs a Snowflake connection fails.
   */
  connectionOptions?: ConnectionOptionsProvider;
  pool?: PoolOptions;
  timeouts?: TimeoutOptions;
  results?: ResultOptions;
  secrets?: SecretsOptions;
  driver?: DriverModule;
  logger?: (event: LogEvent) => void;
};
/** Caller views cannot read app secrets or close the parent client. */
export interface CallerClient extends QueryScope, ConnectionScope, FetchScope {}
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

/** Convenient aggregate of the independently usable SAR components. */
export function createSarClient(input: SarClientOptions = {}): SarClient {
  keys(
    input,
    ["connectionOptions", "pool", "timeouts", "results", "secrets", "driver", "logger"],
    "client",
  );
  const auth = snapshotProvider(input.connectionOptions ?? unconfiguredOptions);
  const timeouts = timeoutOptions(input.timeouts);
  const connections = createConnectionManager(auth, {
    pool: input.pool,
    timeouts,
    driver: input.driver,
    logger: input.logger,
  });
  const queries = createQueryClient(connections, { results: input.results, timeouts });
  const http = createFetchClient(auth, { timeouts });
  const secrets = createSecrets(input.secrets);
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    query: queries.query,
    stream: queries.stream,
    submit: queries.submit,
    transaction: queries.transaction,
    submitDetached: queries.submitDetached,
    pollQuery: queries.pollQuery,
    streamQuery: queries.streamQuery,
    getQueryStatus: queries.getQueryStatus,
    cancelQuery: queries.cancelQuery,
    fetch: http.fetch,
    connect: connections.connect,
    withConnection: connections.withConnection,
    diagnostics: connections.diagnostics,
    secrets: Object.freeze({
      getString: secrets.getString,
      getPassword: secrets.getPassword,
      getAccessToken: secrets.getAccessToken,
    }),
    asCaller(context: CallerContext): CallerClient {
      if (closed) fail("CLIENT_CLOSED", "Client is closed");
      // Snapshot a possibly stateful header reader once across the component scopes.
      const token = callerToken(context);
      const snapshot: CallerContext = token === null ? { headers: { get: () => null } } : { token };
      const scopedConnections = connections.asCaller(snapshot);
      const scopedQueries = bindQueryScope(queries, scopedConnections);
      return Object.freeze({
        query: scopedQueries.query,
        stream: scopedQueries.stream,
        submit: scopedQueries.submit,
        transaction: scopedQueries.transaction,
        submitDetached: scopedQueries.submitDetached,
        pollQuery: scopedQueries.pollQuery,
        streamQuery: scopedQueries.streamQuery,
        getQueryStatus: scopedQueries.getQueryStatus,
        cancelQuery: scopedQueries.cancelQuery,
        withConnection: scopedConnections.withConnection,
        fetch: http.asCaller(snapshot).fetch,
      });
    },
    close(settings: CloseOptions = {}) {
      if (closing) return closing;
      keys(settings, ["timeoutMs"], "close");
      duration(settings.timeoutMs, "close timeout");
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([
          http.close(),
          secrets.close(),
          connections.close(settings),
          queries.close(settings),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return closing;
    },
  });
}
