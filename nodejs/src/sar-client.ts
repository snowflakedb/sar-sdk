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

import { callerToken } from "./connection-options/caller.js";
import { createConnectionOptions } from "./connection-options/connection-options.js";
import { createConnectionManager } from "./connection-manager/connection-manager.js";
import { createFetchClient } from "./fetch-client/fetch-client.js";
import { createQueryClient } from "./query-client/query-client.js";
import { createSecretsClient } from "./secrets-client/secrets-client.js";
import type { CallerContext } from "./connection-options/caller.js";
import type { ConnectionOptionsProvider } from "./connection-options/connection-options.js";
import type { ClientDiagnostics } from "./connection-manager/connection-manager.js";
import type { CloseOptions } from "./core/lifecycle.js";
import type { FetchClient, FetchScope } from "./fetch-client/fetch-client.js";
import type { QueryClient, QueryCallerScope } from "./query-client/query-client.js";
import type { SecretsClient, Secrets } from "./secrets-client/secrets-client.js";
import type snowflake from "snowflake-sdk";
import { duration, fail, keys } from "./core/errors.js";

/**
 * The components a SarClient composes. createSarClient takes them over: its close() closes all
 * three. In a caller view, SQL uses the query client's connection options and fetch uses the fetch
 * client's.
 */
export type SarClientComponents = {
  queryClient: QueryClient;
  fetchClient: FetchClient;
  secretsClient: SecretsClient;
};
/** Caller views cannot read app secrets or close the parent client. */
export interface CallerClient extends QueryCallerScope, FetchScope {}
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

/** Components that share one provider, so SQL and fetch use the same connection options. */
function componentsFrom(connectionOptions: ConnectionOptionsProvider): SarClientComponents {
  return {
    queryClient: createQueryClient(createConnectionManager(connectionOptions)),
    fetchClient: createFetchClient(connectionOptions),
    secretsClient: createSecretsClient(),
  };
}

const forms =
  "createSarClient takes no arguments, connection options from createConnectionOptions(), or { queryClient, fetchClient, secretsClient }";
const methods: Record<keyof SarClientComponents, { factory: string; names: string[] }> = {
  queryClient: {
    factory: "createQueryClient(connectionManager)",
    names: [
      "query",
      "stream",
      "submit",
      "transaction",
      "asCaller",
      "connect",
      "withConnection",
      "diagnostics",
      "close",
    ],
  },
  fetchClient: { factory: "createFetchClient()", names: ["fetch", "asCaller", "close"] },
  secretsClient: { factory: "createSecretsClient()", names: ["getString", "close"] },
};
const isProvider = (input: object): input is ConnectionOptionsProvider =>
  typeof (input as Partial<ConnectionOptionsProvider>).getOwnerOptions === "function" &&
  typeof (input as Partial<ConnectionOptionsProvider>).getCallerOptions === "function";

function componentsOf(input: unknown, extra: number): SarClientComponents {
  if (extra > 0) fail("INVALID_OPTIONS", forms);
  if (input === undefined) return componentsFrom(createConnectionOptions());
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_OPTIONS", forms);
  if (isProvider(input)) return componentsFrom(input);
  const names = Object.keys(methods) as (keyof SarClientComponents)[];
  const unknown = Object.keys(input).find((key) => !(names as string[]).includes(key));
  if (unknown !== undefined) fail("INVALID_OPTIONS", `Unknown client option: ${unknown}. ${forms}`);
  const components = input as Partial<SarClientComponents>;
  const missing = names.filter((name) => components[name] === undefined);
  if (missing.length) fail("INVALID_OPTIONS", `Missing client components: ${missing.join(", ")}`);
  for (const name of names) {
    const component = components[name] as unknown as Record<string, unknown> | null;
    const { factory, names: required } = methods[name];
    if (
      !component ||
      typeof component !== "object" ||
      required.some((method) => typeof component[method] !== "function")
    )
      fail("INVALID_OPTIONS", `${name} must be a client created with ${factory}`);
  }
  return components as SarClientComponents;
}

/**
 * The SDK client, in one of three forms:
 * - `createSarClient()`: everything from the default connection options (fromDefault()).
 * - `createSarClient(connectionOptions)`: everything from one provider, such as
 *   `createConnectionOptions(fromToml({ name }), { callerAsOwner: true })`.
 * - `createSarClient({ queryClient, fetchClient, secretsClient })`: components you configure.
 * The first two read their connection options only when work needs them, and close() closes all
 * the components either way.
 */
export function createSarClient(): SarClient;
export function createSarClient(connectionOptions: ConnectionOptionsProvider): SarClient;
export function createSarClient(components: SarClientComponents): SarClient;
export function createSarClient(
  input?: ConnectionOptionsProvider | SarClientComponents,
  ...extra: unknown[]
): SarClient {
  const { queryClient, fetchClient, secretsClient } = componentsOf(input, extra.length);
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    query: queryClient.query,
    stream: queryClient.stream,
    submit: queryClient.submit,
    transaction: queryClient.transaction,
    submitDetached: queryClient.submitDetached,
    pollQuery: queryClient.pollQuery,
    streamQuery: queryClient.streamQuery,
    getQueryStatus: queryClient.getQueryStatus,
    cancelQuery: queryClient.cancelQuery,
    fetch: fetchClient.fetch,
    connect: queryClient.connect,
    withConnection: queryClient.withConnection,
    diagnostics: queryClient.diagnostics,
    secrets: Object.freeze({
      getString: secretsClient.getString,
      getPassword: secretsClient.getPassword,
      getAccessToken: secretsClient.getAccessToken,
    }),
    asCaller(context: CallerContext): CallerClient {
      if (closed) fail("CLIENT_CLOSED", "Client is closed");
      // Snapshot a possibly stateful header reader once across the component views.
      const token = callerToken(context);
      const snapshot: CallerContext = token === null ? { headers: { get: () => null } } : { token };
      const queries = queryClient.asCaller(snapshot);
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
        withConnection: queries.withConnection,
        fetch: fetchClient.asCaller(snapshot).fetch,
      });
    },
    close(settings: CloseOptions = {}) {
      if (closing) return closing;
      keys(settings, ["timeoutMs"], "close");
      duration(settings.timeoutMs, "close timeout");
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([
          fetchClient.close(),
          secretsClient.close(),
          queryClient.close(settings),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return closing;
    },
  });
}
