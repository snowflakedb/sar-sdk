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

import {
  createSarClient,
  type FetchInit,
  type QueryResult,
  type QueryReference,
  type QueryPollResult,
  type QueryStreamResult,
  type QueryCancellation,
  type SarClient,
  type Transaction,
  type TransactionQueryOptions,
} from "../../src/index.js";
import { createConnectionOptions, fromDefault, fromPlatform, fromToml } from "../../src/auth.js";
const client: SarClient = createSarClient({
  connectionOptions: createConnectionOptions({
    account: "test",
    authenticator: "OAUTH",
    token: "synthetic",
  }),
});
const result: Promise<QueryResult<{ ID: string }>> = client.query<{ ID: string }>(
  "SELECT ID FROM ITEMS",
);
void result;
function resultTypes(completed: QueryResult) {
  const affectedRows: number | undefined = completed.affectedRows;
  // @ts-expect-error Only statements with a DML count report affected rows.
  const counted: number = completed.affectedRows;
  void affectedRows;
  void counted;
}
void resultTypes;
const counted: Promise<QueryResult<{ TOTAL: number }>> = createSarClient({
  connectionOptions: createConnectionOptions(fromToml({ name: "dev" })),
  results: { numbers: "number" },
}).query<{ TOTAL: number }>("SELECT COUNT(*) AS TOTAL FROM ITEMS");
void counted;
void client.query("SELECT 1", { numbers: "number" });
// @ts-expect-error Numbers are strings or exact JavaScript numbers, not bigints.
void client.query("SELECT 1", { numbers: "bigint" });
const caller = client.asCaller({ headers: new Headers() });
void caller.query("SELECT 1");
const response: Promise<Response> = client.fetch("/api/v2/test", { method: "GET" });
const callerResponse: Promise<Response> = caller.fetch("/api/v2/test", {
  signal: AbortSignal.timeout(1000),
});
void response;
void callerResponse;
const streaming: FetchInit = { method: "POST", body: "{}", timeoutMs: 900_000 };
void client.fetch("/api/v2/test", streaming);
void caller.fetch("/api/v2/test", { timeoutMs: 5_000 });
void createSarClient({ timeouts: { httpMs: 600_000 } });
// @ts-expect-error The per-request deadline is a number of milliseconds.
void caller.fetch("/api/v2/test", { timeoutMs: "15m" });
// @ts-expect-error The client HTTP deadline is a number of milliseconds.
void createSarClient({ timeouts: { httpMs: "10m" } });
// @ts-expect-error Authenticated fetch is directly on the SDK client, with no rest alias.
void client.rest;
// @ts-expect-error Caller views expose the same flat fetch API.
void caller.rest;
// @ts-expect-error Fetch takes an account-relative string path, not a Request object.
void client.fetch(new Request("https://test.invalid"));
const callerConnectionId: Promise<string> = client
  .asCaller({ headers: new Headers() })
  .withConnection(async (connection) => connection.getId());
const ownerConnectionId: Promise<string> = client.withConnection(async (connection) =>
  connection.getId(),
);
void callerConnectionId;
void ownerConnectionId;
void caller.withConnection(async (connection) => connection.getId());
// @ts-expect-error Caller identity comes from asCaller({ headers }), not withConnection options.
void client.withConnection({ asCaller: true, headers: new Headers() }, async () => undefined);
// @ts-expect-error Caller identity comes from asCaller({ headers }), not withConnection options.
void client.withConnection({ asCaller: true }, async () => undefined);
// @ts-expect-error The app identity takes no options.
void client.withConnection({}, async (connection) => connection.getId());
// @ts-expect-error The app identity takes no options.
void client.withConnection({ asCaller: false }, async (connection) => connection.getId());
// @ts-expect-error The app identity takes no options, so headers are never silently ignored.
void client.withConnection({ asCaller: false, headers: new Headers() }, async () => undefined);
// @ts-expect-error Options never follow the callback.
void client.withConnection(async () => undefined, { asCaller: true, headers: new Headers() });
// @ts-expect-error Caller views cannot switch identity or acquire owner connections.
void caller.withConnection({ asCaller: false }, async () => undefined);
import { createConnectionManager } from "../../src/connections.js";
import { createQueryClient } from "../../src/queries.js";
import { createFetchClient, type FetchInit as HttpFetchInit } from "../../src/account-http.js";
import { createSecrets } from "../../src/secret-client.js";
const auth = createConnectionOptions(fromPlatform());
const manager = createConnectionManager(auth, {
  pool: { mode: "reusable", reset: async () => {} },
});
const queries = createQueryClient(manager);
void queries.asCaller({ headers: new Headers() }).query("SELECT 1");
void createQueryClient(manager, { results: { numbers: "number" } }).query("SELECT 1");
const scopedQueries = createQueryClient(manager.asCaller({ token: "synthetic" }));
// @ts-expect-error Scoped query clients cannot switch identity.
scopedQueries.asCaller({ token: "other" });
// @ts-expect-error Native caller views cannot close their manager.
manager.asCaller({ token: "synthetic" }).close();
// @ts-expect-error Reusable mode requires reset.
createConnectionManager(auth, { pool: { mode: "reusable" } });
// @ts-expect-error Reset is asynchronous.
createConnectionManager(auth, { pool: { mode: "reusable", reset: () => undefined } });
// @ts-expect-error Isolated mode cannot configure reset.
createConnectionManager(auth, { pool: { mode: "isolated", reset: async () => {} } });
// @ts-expect-error Native callbacks must await driver work.
manager.withConnection((connection) => connection.execute({ sqlText: "SELECT 1" }));
// @ts-expect-error Manager caller identity comes from asCaller(context).
void manager.withConnection({ asCaller: true, headers: new Headers() }, async () => undefined);
const standaloneResponse: Promise<Response> = createFetchClient(auth).fetch("/api/v2/test");
const standaloneInit: HttpFetchInit = { timeoutMs: 5_000 };
void createFetchClient(auth, { timeouts: { httpMs: 600_000 } })
  .asCaller({ token: "synthetic" })
  .fetch("/api/v2/test", standaloneInit);
const secret: Promise<string> = createSecrets().getString("KEY");
void standaloneResponse;
void secret;
import snowflake from "snowflake-sdk";
const ownerOptions: snowflake.ConnectionOptions = auth.getOwnerOptions();
snowflake.createConnection(ownerOptions);
snowflake.createPool(auth.getCallerOptions("synthetic"), { min: 0, max: 2 });
// @ts-expect-error The caller's token is a string, not caller context.
auth.getCallerOptions({ headers: new Headers() });
// @ts-expect-error Options are returned synchronously, not as a Promise.
void auth.getOwnerOptions().then((options) => options);
// @ts-expect-error The provider has no resources to close.
void auth.close();
// @ts-expect-error Discovery configuration belongs to the application, not the client.
createSarClient({ auth: { providers: [] } });
// @ts-expect-error Removed pre-release resolver injection has no compatibility alias.
createSarClient({ authResolver: auth });
const ownedFactoryClient: SarClient = createSarClient({
  connectionOptions: createConnectionOptions(
    process.env.NODE_ENV === "development"
      ? fromToml({ name: "dev", configFile: "/test-only/connections.toml" })
      : fromPlatform(),
    { callerAsOwner: process.env.NODE_ENV === "development" },
  ),
  logger: (event) => void event.event,
});
void ownedFactoryClient;
void createSarClient({ connectionOptions: undefined });
// @ts-expect-error The SDK no longer opens connections from a profile name.
createSarClient({ connection: { name: "dev", warehouse: "APP_WH" } });
// @ts-expect-error The SDK no longer detects its environment.
createSarClient({ environment: "auto" });
// @ts-expect-error The SDK no longer detects its platform.
createSarClient({ platform: "auto" });
// @ts-expect-error The SDK no longer authenticates interactively.
createSarClient({ interactive: "always" });
// @ts-expect-error The caller fallback policy is gone.
createSarClient({ callerFallback: "error" });
// @ts-expect-error callerAsOwner is an option of createConnectionOptions.
createSarClient({ connectionOptions: auth, callerAsOwner: true });
// @ts-expect-error Driver options belong in the native connection options.
createSarClient({ driverOptions: { clientStoreTemporaryCredential: true } });
// @ts-expect-error There is no client-level authentication deadline.
createSarClient({ timeouts: { authMs: 30_000 } });
// @ts-expect-error The factory takes explicit connection options, not undefined.
createConnectionOptions(undefined);
void createConnectionOptions({ account: "test" }, { callerAsOwner: true });
// @ts-expect-error The app passes a boolean condition, not an environment name.
createConnectionOptions({ account: "test" }, { callerAsOwner: "development" });
// @ts-expect-error The removed caller fallback policy has no compatibility alias.
createConnectionOptions({ account: "test" }, { callerFallback: "unless-deployed" });
// @ts-expect-error The platform source takes no options; SPCS and Serverless mount the same token.
fromPlatform({ platform: "spcs" });
createConnectionOptions(fromDefault(), { callerAsOwner: true });
// @ts-expect-error The default source takes no options; call fromToml({ name }) to pick a profile.
fromDefault({ name: "dev" });
// @ts-expect-error Native connection options are not a provider.
createConnectionManager({ account: "test" });

async function detachedTypes(client: SarClient, reference: QueryReference) {
  const submitted: QueryReference = await client.submitDetached("SELECT 1", {
    submitTimeoutMs: 10_000,
    executionTimeoutMs: 60_000,
    rowMode: "array",
  });
  const result: QueryPollResult<{ ID: string }> = await client.pollQuery<{ ID: string }>(
    submitted,
    { lookupTimeoutMs: 10_000, consumeTimeoutMs: 30_000 },
  );
  if (result.status === "complete") result.result.rows[0]?.ID.toUpperCase();
  // @ts-expect-error Pending has no result payload.
  if (result.status === "pending") void result.result;
  const streamed: QueryStreamResult<{ ID: string }> = await client.streamQuery<{ ID: string }>(
    submitted,
    { lookupTimeoutMs: 10_000, consumeTimeoutMs: 30_000, signal: AbortSignal.timeout(60_000) },
  );
  if (streamed.status === "complete") {
    for await (const row of streamed.stream) row.ID.toUpperCase();
    await streamed.stream.close();
  }
  // @ts-expect-error Pending has no stream.
  if (streamed.status === "pending") void streamed.stream;
  // @ts-expect-error A streamed result has no materialized rows.
  if (streamed.status === "complete") void streamed.result;
  const numbers: "string" | "number" = submitted.results.numbers ?? "string";
  void numbers;
  // @ts-expect-error Saved references omit numbers unless it's "number".
  const saved: "string" | "number" = submitted.results.numbers;
  void saved;
  await client.submitDetached("SELECT 1", { numbers: "number" });
  const status: string = await client.asCaller({ token: "synthetic" }).getQueryStatus(reference);
  void status;
  await queries.cancelQuery(reference);
  const cancellation: QueryCancellation = await client.cancelQuery(reference);
  if (!cancellation.cancelled) cancellation.status.toUpperCase();
  // @ts-expect-error A confirmed cancellation has no terminal status to report.
  if (cancellation.cancelled) void cancellation.status;
  await scopedQueries.pollQuery(reference);
  await scopedQueries.streamQuery(reference);
  await queries.asCaller({ token: "synthetic" }).streamQuery(reference);
  await client.asCaller({ token: "synthetic" }).streamQuery(reference);
  // @ts-expect-error Streaming cannot override the saved limits or result settings.
  await client.streamQuery(reference, { maxRows: 1_000_000 });
  // @ts-expect-error Streaming checks once; it has no server-side availability wait.
  await client.streamQuery(reference, { waitMs: 0 });
  // @ts-expect-error Reference must come from trusted server storage, not a bare query ID.
  await client.pollQuery(reference.queryId);
  // @ts-expect-error Decoders are retrieval-only and cannot be serialized in a reference.
  await client.submitDetached("SELECT 1", { decodeRow: (row: unknown) => row });
  // @ts-expect-error Detached submission uses its own submission timeout.
  await client.submitDetached("SELECT 1", { waitTimeoutMs: 100 });
  // @ts-expect-error Retrieval cannot override saved result settings.
  await client.pollQuery(reference, { format: "native" });
  // @ts-expect-error Saved number handling cannot be overridden either.
  await client.pollQuery(reference, { numbers: "number" });
  // @ts-expect-error Detached retrieval checks once; it has no server-side availability wait.
  await client.pollQuery(reference, { waitMs: 0 });
  // @ts-expect-error The browser schedules polling intervals, not the detached SDK operation.
  await client.pollQuery(reference, { pollIntervalMs: 1_000 });
  // @ts-expect-error Reference metadata is immutable.
  reference.identity.user = "OTHER";
}
void detachedTypes;

async function transactionTypes(client: SarClient) {
  const total: number = await client.transaction(
    async (tx: Transaction) => {
      const statement: TransactionQueryOptions = { binds: ["OPEN"], rowMode: "object" };
      const result = await tx.query<{ ID: string }>("SELECT ID FROM ORDERS", statement);
      result.rows[0]?.ID.toUpperCase();
      return result.rowCount;
    },
    { warehouse: "APP_WH", signal: AbortSignal.timeout(1000), acquireTimeoutMs: 1000 },
  );
  void total;
  await client.asCaller({ token: "synthetic" }).transaction(async (tx) => tx.query("SELECT 1"));
  await queries.transaction(async (tx) => tx.query("SELECT 1", { rowMode: "array" }), {
    format: "native",
  });
  await queries.asCaller({ token: "synthetic" }).transaction(async () => undefined);
  await scopedQueries.transaction(async () => undefined);
  // @ts-expect-error The result format is chosen once per transaction.
  await client.transaction(async (tx) => tx.query("SELECT 1", { format: "native" }));
  // @ts-expect-error The transaction format is a result format name.
  await client.transaction(async () => undefined, { format: "csv" });
  // @ts-expect-error The warehouse is chosen once per transaction.
  await client.transaction(async (tx) => tx.query("SELECT 1", { warehouse: "OTHER_WH" }));
  // @ts-expect-error Session acquisition deadlines are per transaction.
  await client.transaction(async (tx) => tx.query("SELECT 1", { acquireTimeoutMs: 1000 }));
  // @ts-expect-error Statement deadlines are per statement.
  await client.transaction(async () => undefined, { waitTimeoutMs: 1000 });
  // @ts-expect-error Callbacks must return a Promise that awaits every statement.
  await client.transaction(() => undefined);
}
void transactionTypes;
