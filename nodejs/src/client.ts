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

import { snapshotProvider, unconfiguredOptions } from "./auth-client.js";
import { callerToken } from "./caller.js";
import { createConnectionManager } from "./connections.js";
import { createFetchClient } from "./fetch-client.js";
import { createQueryClient, bindQueryScope } from "./query.js";
import { createSecrets } from "./secrets.js";
import { clientOptions } from "./options.js";
import { duration, fail, keys } from "./errors.js";
import type {
  CallerClient,
  CallerContext,
  CloseOptions,
  SarClient,
  SarClientOptions,
} from "./types.js";

/** Convenient aggregate of the independently usable SAR components. */
export function createSarClient(input: SarClientOptions = {}): SarClient {
  const options = clientOptions(input);
  const auth = snapshotProvider(options.connectionOptions ?? unconfiguredOptions);
  const connections = createConnectionManager(auth, {
    pool: options.pool,
    timeouts: options.timeouts,
    driver: options.driver,
    logger: options.logger,
  });
  const queries = createQueryClient(connections, {
    results: options.results,
    timeouts: options.timeouts,
  });
  const http = createFetchClient(auth, { timeouts: options.timeouts });
  const secrets = createSecrets(options.secrets);
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
