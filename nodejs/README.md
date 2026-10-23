<!--
Copyright 2026 Snowflake Inc.
SPDX-License-Identifier: Apache-2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# @snowflake/sar-sdk

A framework-neutral, server-side Node.js SDK for **Snowflake App Runtime (SAR)**, built on
`snowflake-sdk`. It separates Snowflake access from application frameworks: caller identity,
owned SQL sessions, bounded results, secrets, and account HTTP. Its clients are independent and
lazy. Node.js server code only; not for browsers or Edge. This is an unpublished development
package, and it doesn't replace the Snowflake Node.js driver.

Browser applications call their own authenticated backend endpoints and schedule
polling themselves. The SDK provides no client-side query or polling utilities
today; those may be added in the future. Keep Snowflake credentials and saved
query references on the server.

## Getting started

There is no public npm release to install yet. From a checkout, run `npm ci` in `nodejs/` with
its documented toolchain, then `npm run build`. For a local consumer, run `npm pack` there and
install the resulting tarball; this does not publish anything. Keep the tarball out of source
control.

### Configure TypeScript

The tested TypeScript baseline is 5.9. Use `module`/`moduleResolution: "NodeNext"` (Node.js)
or `moduleResolution: "Bundler"` (a server bundler), and Node.js type declarations.
Both ESM and CommonJS declarations are included. Node >=22 is required.
JavaScript consumers need no TypeScript compiler. The tested driver is exactly 3.4.0.

```ts
import { createSarClient } from "@snowflake/sar-sdk";

const client = createSarClient();
try {
  const result = await client.query("SELECT CURRENT_USER() AS USER_NAME");
  console.log(result.rows);
} finally {
  await client.close();
}
```

## Common tasks

Create one client per server process, reuse it across requests, and close it at shutdown.
Frameworks that reload modules during development can keep it on `globalThis`:

```ts
import { createSarClient, type SarClient } from "@snowflake/sar-sdk";

const cache = globalThis as typeof globalThis & { snowflake?: SarClient };
export const snowflake = (cache.snowflake ??= createSarClient());
```

Run SQL as the app, passing values as binds rather than building SQL strings:

```ts
const { rows } = await snowflake.query("SELECT NAME, PRICE FROM PRODUCTS WHERE ID = ?", {
  binds: [id],
});
```

Rows are objects keyed by column name, upper case unless quoted in SQL. In the default JSON
format, NUMBER values are decimal strings, so convert them where a JavaScript number is exact.
See [Queries and Ownership](#queries-and-ownership) for every type.

Run SQL as the signed-in user with a caller view built from the request's headers. Use it only
within that request:

```ts
export async function GET(request: Request) {
  const caller = snowflake.asCaller({ headers: request.headers });
  const { rows } = await caller.query("SELECT CURRENT_USER() AS NAME");
  return Response.json(rows[0]);
}
```

Caller queries use the user's default role and warehouse. Pass `warehouse` per query, or set
`SNOWFLAKE_WAREHOUSE` in the app's environment, for users without a default warehouse.
In recognized local development, a caller view without caller headers uses the app's identity. To
run caller views as the app even when caller headers are present, such as in development, create
the client with `callerAsOwner: process.env.NODE_ENV === "development"`.
[Caller Context](#caller-context) describes both.

Handle failures by their stable `code`. When Snowflake rejects a query, `details.errorCode` holds
its error code:

```ts
import { isSarError } from "@snowflake/sar-sdk";

try {
  await snowflake.query("UPDATE ORDERS SET STATUS = 'SHIPPED' WHERE ID = ?", { binds: [id] });
} catch (error) {
  if (isSarError(error) && error.details.errorCode === "002003")
    return new Response("Orders table unavailable", { status: 503 });
  throw error;
}
```

The SDK never retries SQL. Before retrying a write yourself, check `details.completion`:
`"succeeded"` means the statement ran even though reading its result failed, and `"unknown"`
means it may have.

Stream results too large for `query()`, which stops at 100,000 rows or 32 MiB by default.
Leaving the loop early releases the session:

```ts
const stream = await snowflake.stream("SELECT * FROM EVENTS ORDER BY CREATED_AT");
for await (const row of stream) await write(row);
```

Each operation runs in its own session. For transactions, temporary tables, or session variables
that span statements, use `withConnection` (see [Queries and Ownership](#queries-and-ownership)).
For work that outlives a request, see
[Detached queries](#detached-queries-across-requests-and-instances). Read app secrets with
`snowflake.secrets.getString(name)`, and quiet the driver's per-connection logging as shown in
[Diagnostics and Driver Injection](#diagnostics-and-driver-injection).

## Independent components

Use only the layers you need. `createSarClient()` is a convenience aggregate of these
same components, not a requirement for native driver access.

```ts
import { createConnectionOptions } from "@snowflake/sar-sdk/auth";
import { createConnectionManager } from "@snowflake/sar-sdk/connections";
import { createQueryClient } from "@snowflake/sar-sdk/query";
import { createFetchClient } from "@snowflake/sar-sdk/http";
import { createSecrets } from "@snowflake/sar-sdk/secrets";

const auth = createConnectionOptions();
const connections = createConnectionManager(auth);
const queries = createQueryClient(connections);
const http = createFetchClient(auth);
const secrets = createSecrets();

try {
  await connections.withConnection(async (connection) => {
    await new Promise<void>((resolve, reject) => {
      connection.execute({
        sqlText: "SELECT CURRENT_USER()",
        complete(error) {
          if (error) reject(error);
          else resolve();
        },
      });
    });
  });
  const result = await queries.query("SELECT CURRENT_USER() AS USER_NAME");
} finally {
  await Promise.all([queries.close(), connections.close(), http.close(), secrets.close()]);
  await auth.close();
}
```

The native callback must return a Promise and await all driver execution and streaming.
Returning `connection.execute(...)` directly is rejected: a Statement is not completion.
The manager owns connections; query clients borrow their supplied manager. Closing a
query client disposes only its work, not other clients' work or the manager. A supplied
options provider is borrowed. Close it after its consumers. Use
`createSarClient({ connectionOptions: auth })` for the aggregate over the same provider.
Authentication/discovery and driver tuning belong to the factory, not to manager, query, or fetch
options. Without `connectionOptions`, `createSarClient()` accepts them for the factory it creates
and closes (see [Configuration](#configuration)); with it, configure the supplied provider instead.

`getOwnerOptions({ signal?, timeoutMs? })` and
`getCallerOptions({ headers } | { token }, { signal?, timeoutMs? })` return fresh mutable
`snowflake-sdk` connection options. They do not log in or open SQL. Results contain secrets:
never log, serialize, or return them to HTTP callers. `diagnostics()` does not acquire
credentials. Factory `close()` aborts its waits, not native connections already created.
Custom structural providers implement the same two getters; diagnostics are optional.
They are trusted application code responsible for caller policy and redacted diagnostics.

```ts
import snowflake from "snowflake-sdk";
const connection = snowflake.createConnection(await auth.getOwnerOptions());
// The application connects, awaits native execution, and destroys the connection.
```

`snowflake.createPool(await auth.getOwnerOptions(), { min: 0, max: 4 })` also works,
but captures one credential snapshot. It does not call the getter for future connections.
Use the SDK manager or an application-owned resource factory for rotating login credentials.
Native pools require application-owned identity isolation, reset, and `drain()` plus `clear()`
cleanup. Native results do not inherit SDK conversion, row limits, or query lifecycle helpers.

Standalone secrets expose the three getters plus `close()`. Standalone fetch exposes
`fetch`, `asCaller`, and `close`; neither requires SQL. `createQueryClient()` accepts
either a manager or a caller-scoped connection view. The latter cannot switch identity.
Result/timeouts and `handleIdleTimeoutMs` may be configured on the query client.

## Caller Context

```ts
const caller = client.asCaller({ headers: request.headers });
const result = await caller.query("SELECT ID FROM ORDERS WHERE STATUS = ?", {
  binds: ["OPEN"],
});
```

The SDK knows the Snowflake header name. Headers must come from trusted platform
ingress; extraction is not authentication. A caller view has query, stream, submit,
transaction, detached-query, withConnection, and fetch operations, but no app secrets or parent
close.
Never retain a caller view beyond its request/job.

For raw driver work as the caller, call `withConnection` on a caller view:

```ts
const id = await client
  .asCaller({ headers: request.headers })
  .withConnection(async (connection) => connection.getId());
```

`client.withConnection(callback)` uses the app identity and takes only the callback; options
such as `{ asCaller: true, headers }` throw `INVALID_OPTIONS`. Caller views cannot switch back to
the app identity.

SPCS and Serverless use separate adapters. SPCS composes the service and caller tokens;
Serverless uses its ingress-provided caller OAuth credential directly. The Serverless
mounted app credential may be an opaque static placeholder. The SDK never parses it as
a JWT or assumes unchanged contents mean unchanged platform credentials.

By default (`callerFallback: "auto"`), missing caller context falls back to the app identity only
in recognized local or Serverless preview execution. Platform credentials without preview evidence
mean deployed mode. `NODE_ENV` alone is not local evidence. Trusted applications can specify
`environment: "local"` when necessary, but not to override platform evidence: on the platform it
throws `ENVIRONMENT_CONFLICT`. `"error"` requires callers everywhere. Set `callerFallback` on
`createSarClient()` or the options factory; a refusal's `details.nextStep` suggests a fix.
Present-but-empty headers and explicit empty tokens fail in every environment.
Only source/platform metadata selects SPCS/Serverless composition; generic OAuth/PAT tokens
do not acquire caller support merely by containing a token or being used on a platform.

`callerAsOwner: true` runs every caller view as the app, even when caller context is present. Use
it where caller's rights don't work for your app yet: on a local server, or in Snowflake Workspaces
preview, which sends a valid caller token that doesn't behave as apps need. Caller views then use
the app's credentials for queries, `withConnection`, and `fetch`, follow owner session rules
instead of the caller-view reuse described below, and save `mode: "owner"` detached references.
The factory's `getCallerOptions()` returns owner options, and `callerFallback` doesn't apply.
Caller context is still validated, so malformed headers and empty tokens still fail. The SDK
doesn't decide when to set it: pass your app's own condition, and change it once the platform
supports what your app needs. Set it on `createSarClient()` or the options factory.

```ts
const client = createSarClient({ callerAsOwner: process.env.NODE_ENV === "development" });
```

A caller view reuses its sessions. Its first operation logs in, and later operations in the same
view run on that session, or on additional sessions when they run concurrently, without logging in
again. They keep working after the caller token expires, which is two minutes after the request by
default (`SERVICE_CALLER_TOKEN_VALIDITY_SECS`). Sessions are reused only within the same
`asCaller()` view and warehouse. An operation that fails, is aborted, or leaves a stream early
retires its session instead. Session changes an operation makes, such as `USE` or session
variables, are visible to the view's later operations.

On SPCS, Snowflake gives every login with the same caller token one Snowflake session, so a
request's caller work shares session state across views and concurrent operations: session
variables, `USE` and `ALTER SESSION` changes, temporary tables, and an open transaction. A caller
`transaction()` therefore runs alone. While it's open, other SQL for the same caller context fails
with `INVALID_OPTIONS` instead of running inside the transaction; run that SQL with `tx.query()` or
after the transaction ends. A caller transaction also refuses to start while other SQL for that
caller context is running, such as an unfinished stream or `submit()` handle. The client enforces
this on every platform, for all of its views; it doesn't check `fetch()` requests, which use the
same Snowflake session on SPCS, or other clients.

Snowflake stops accepting a caller token for new logins once any session made from it logs out, so
the view's sessions log out together after it has had no session in use for 60 seconds, or when the
client closes. A view idle for longer can't log in again, which is one more reason to keep it within
one request. Sessions waiting for reuse or logout don't count toward `maxConnections`. Caller
sessions use the calling user's default role and warehouse; for users without a default warehouse,
pass `warehouse` per query or set `SNOWFLAKE_WAREHOUSE` in the app's environment.

Caller's rights on SPCS are restricted: a caller session can do only what both the caller and the
app owner role's caller grants allow. Cancelling a caller's query, with `cancelQuery()` or a
`submit()` handle's `cancel()`, needs `CALLER OPERATE` on the warehouse for the owner role. Without
it, Snowflake refuses with error `003001` and the query keeps running; the SDK throws
`QUERY_FAILED` with that `errorCode` and a `nextStep` naming the grant.

## Configuration

Default factory discovery order is platform credentials, a complete environment identity, then
the SnowCLI-compatible default profile. Selecting `connection.name`,
`SNOWFLAKE_CONNECTION_NAME`, or `SNOWFLAKE_DEFAULT_CONNECTION_NAME` goes directly
to that profile. A missing selected profile never selects the first entry.

`createSarClient()` passes `connection`, `environment`, `platform`, `interactive`,
`callerFallback`, `callerAsOwner`, `driverOptions`, and `logger` to the options factory it creates
and closes, and `timeouts.authMs` as its `authTimeoutMs`. Combining them with `connectionOptions`
throws `INVALID_OPTIONS`. For example, a development server that `npm run dev` starts without a
terminal can select a profile, allow browser SSO, and run caller views as the app:

```ts
const client = createSarClient({
  connection: { name: "dev", warehouse: "APP_WH" },
  interactive: "always",
  callerAsOwner: process.env.NODE_ENV === "development",
});
```

For profiles, precedence is explicit SDK context, named environment overrides,
profile values, then generic environment defaults. Explicit identity conflicts
are rejected, not silently merged. `connections.toml` replaces connection
definitions from `config.toml`. Both conventional top-level connection tables
and nested `connections` tables are supported. Relative key/token paths resolve
against the configuration directory, not the process working directory. This
deliberate rule is not a claim of compatibility with every SnowCLI version.

The resolver supports `SNOWFLAKE_HOME`, explicit `connection.configFile`,
`~/.snowflake`, and documented macOS/Windows/Linux configuration directories.
On POSIX, configuration files must be private (`0600`). It does not shell out to
SnowCLI or other tools and does not read private credential caches. Other tools share these
profiles, so the SDK skips profile keys it doesn't use, such as `oauth_enable_refresh_tokens`,
instead of failing. Once an operation selects the profile, `diagnostics()` lists the skipped
names, never their values, in `ignoredProfileKeys`, and the factory `logger` receives one
`profile-keys-ignored` event with the same `keys`. A misspelled key is skipped too, so check that
list when a profile setting has no effect. Keys the SDK uses are still type-checked, and unknown
fields in `connection` options supplied in code still throw.
Separate `region` is rejected; use a region-qualified account identifier or an
explicit HTTPS endpoint. SDK options and provider registrations are snapshots.
Profile/environment source resolution is retained, including failures; recreate the
factory after changing that configuration. Use token files or a custom provider's
`acquire()` for credentials that must rotate without client recreation.

```ts
import { createConnectionOptions, fromTokenFile, fromToml } from "@snowflake/sar-sdk/auth";

const options = createConnectionOptions([
  fromTokenFile({
    id: "company",
    path: "/run/company/token",
    type: "oauth",
    optional: true,
    target: { account: "org-account" },
  }),
  fromToml({ name: "development", environmentOverrides: false }),
]);
const client = createSarClient({ connectionOptions: options });
```

An array replaces defaults; `[]` disables discovery. Removing the standalone
environment source does not remove profile overlays; set
`fromToml({ environmentOverrides: false })` separately. A selected source stays
selected after refresh or authentication failure. Providers returning
`undefined` mean absence, not rejection. Custom providers are trusted code.
Provider hook failures receive safe messages; sensitive diagnostics are retained only
as `cause`. Do not serialize the cause or use provider IDs as untrusted display text.

Supported credentials include OAuth, PAT, password, key pairs, and selected
driver-managed login flows. Interactive flows require recognized local
execution and a terminal by default. `interactive: "never"` disables prompts;
`"always"` permits a trusted local integration without a TTY, not a deployment
or CI job. SDK-managed interactive/driver-flow logins are serialized; native consumers
manage login concurrency themselves. Driver credential caching is opt-in
through the profile/provider recipe or `driverOptions.clientStoreTemporaryCredential`;
without caching, fresh sessions may require repeated login. The SDK does not cache SQL
login tokens; its separate client-credentials secret cache is described below.
Explicit factory caching options take precedence over profile/provider tuning.
Driver-managed credential recipes are restricted by `DriverCredentialOptions`; this
is not support for every driver authenticator or arbitrary connection option.
Interactive-login and discovery failures carry a `details.nextStep` hint, which `toJSON()`
includes; hints never contain file paths or credentials.

## Queries and Ownership

By default each owner operation owns a fresh SQL session, and a caller view reuses its own sessions
(see [Caller Context](#caller-context)). Run a multi-statement transaction with
`transaction(async (tx) => ...)`, described below. For other raw driver work, such as temporary
objects that span statements, use `withConnection(async connection => ...)`. Await all
work inside the callback; do not retain or destroy the connection. The SDK
discards it afterward. Arbitrary SQL is not read-only merely because binds are
used. Authorization remains the responsibility of Snowflake and the app.

```ts
await client.transaction(async (tx) => {
  await tx.query("UPDATE ACCOUNTS SET BALANCE = BALANCE - ? WHERE ID = ?", { binds: [100, "A"] });
  await tx.query("UPDATE ACCOUNTS SET BALANCE = BALANCE + ? WHERE ID = ?", { binds: [100, "B"] });
});
```

`transaction()` holds one session for the whole callback, with the same limits and owner or caller
scope as other operations. It runs BEGIN, then the callback, then COMMIT when the callback's Promise
fulfills, and resolves with its value even if releasing the session afterward fails. If the Promise
rejects, ROLLBACK runs and the callback's error is rethrown. `tx.query()` returns what `query()`
returns, with the same conversion, limits, and errors. Concurrent calls run one at a time in call
order; calls after the transaction ends are rejected. Await every statement: a callback that
returns with one outstanding rolls back and throws `INVALID_OPTIONS`. A failed COMMIT throws
`QUERY_FAILED` with `completion: "unknown"`. SQL is never retried. A caller transaction runs alone
for its caller context, because caller sessions share a Snowflake session on SPCS; see
[Caller Context](#caller-context).

Statement options exclude `format`, `warehouse`, `acquireTimeoutMs`, and `authTimeoutMs`; pass
those, and `signal`, to `transaction()`. `format` defaults to the client's, and JSON sets the
temporal formats once, before BEGIN. DDL, such as `CREATE TEMPORARY TABLE`, implicitly commits an
open transaction in Snowflake, so keep it out of the callback. A failed statement doesn't end the
transaction unless the callback rejects.

Aborting the transaction's `signal` cancels the running statement, runs ROLLBACK, and discards the
session. Shutdown discards it without ROLLBACK; Snowflake rolls back a transaction still open when
its session ends. A caller view's discarded sessions log out once the view has been idle for 60
seconds or the client closes (see Caller Context), so a caller transaction discarded without
ROLLBACK stays open until then. A statement's own `signal` or deadline cancels only that statement.
If a cancellation can't be confirmed, no more SQL runs, not even ROLLBACK, and the session is
discarded; a ROLLBACK that fails or takes over 5 seconds also discards it.

Defaults: 10 active connections, 100 queued operations, 30-second acquisition,
120-second authentication, 600-second query wait, 120-second result consumption,
300-second abandoned-handle cleanup, and 10-second graceful shutdown. These are
configurable initial limits, not performance recommendations for every app.
`query()` and `stream()` send a statement and wait for it in one driver request: Snowflake holds the
request while the statement runs and returns its first results with the response. A `submit()`
handle and a transaction statement are submitted asynchronously instead; while they run, status
checks start after 25 ms and back off to `pollIntervalMs`, 1 second by default.
In isolated mode, `query()` returns, and stream iteration ends, once the last row is read;
the session then logs out in the background. Until it does, it counts toward
`activeConnections` and `maxConnections`, and `close()` waits for it. A failed logout
doesn't fail rows that were already read.
`connect()` validates connectivity with a temporary owned session.
In default `pool.mode: "isolated"`, `pool` configures concurrency and queue limits,
not reuse. `maxQueue: 0` rejects work when all admission slots are occupied.

### Optional reusable sessions

Set `pool: { mode: "reusable", reset: async connection => { /* app-specific reset */ } }`
on the manager or aggregate client. A reset hook is mandatory; it must restore all
state your app can change. There is no universal reset for arbitrary SQL. Keep isolated
mode unless you can constrain transactions, variables, temporary objects, and context.
In JSON mode, query helpers set temporal output formats; reset must restore them before
a later native borrower if your application expects different formats. Warehouse overrides
are separate pool partitions. `examples/composition.ts` shows a deliberately narrow contract.

Each session has one borrower at a time, including the entire stream/handle lifetime.
Complete success runs reset before release; errors, early stream exit, cancellation,
or failed reset discard the session. No application SQL is retried automatically.
Connections are reused only within the same owner scope or immutable caller view;
separate `asCaller()` calls never share connections, even with identical tokens, though on SPCS
Snowflake gives same-token connections one session ([Caller Context](#caller-context)). With
`callerAsOwner: true`, caller views use the owner scope and share its sessions. Do not
retain caller views across requests/jobs or treat reuse as proof of current authorization.

`maxConnections` covers local physical connections globally, including connecting, borrowed,
resetting, and idle sessions. Unmatched idle sessions can be evicted for another scope.
Defaults: idle timeout 60 seconds, maximum lifetime 30 minutes, reset timeout 5 seconds.
Configure `idleTimeoutMs`, `maxLifetimeMs`, and `resetTimeoutMs` only in reusable mode.
Lifetime expiry retires a borrowed session on release; it does not interrupt its work.
Local cleanup deadlines do not imply physical destruction: a pending driver destroy
retains its physical slot until it settles. Shutdown can still report a deadline failure.
Mounted credential rotation does not evict established sessions. New logins reopen
token files/acquire current credentials; idle reuse does not acquire credentials again.

`query()` returns `{ rows, queryId, columns, rowCount }`, plus `affectedRows` when Snowflake
reports a DML count: the rows inserted, updated, deleted, or merged, counting each updated row
once even when an UPDATE joins it to several source rows. `rowCount` is returned
rows, not affected rows. JSON format preserves numeric values as strings,
temporal strings with nanosecond formatting and type metadata, binary as base64,
SQL null as null, and raw JSON text for unstructured VARIANT. Set `numbers: "number"`, as in
`createSarClient({ results: { numbers: "number" } })` or per query, to get JavaScript numbers.
A NUMBER value converts only when that is exact: a safe integer, or a decimal such as `12.50`
whose JavaScript number has the same digits. A FLOAT value converts when finite, from the same
text that string mode returns; Snowflake rounds that text to about 15 significant digits. Other
values, such as `9007199254740993` or a FLOAT `NaN`, fail with `RESULT_CONVERSION_UNSUPPORTED`
instead of being rounded; use `numbers: "string"`, or cast the column to VARCHAR. The error names
a column whose name is a plain identifier, and otherwise gives its position. Native format
ignores `numbers`. Unsupported lossy
driver representations fail instead of being advertised as lossless. OBJECT/ARRAY/MAP
columns, including unstructured containers, are rejected in JSON format because the driver
parses them and can round large numbers. Cast such a column to VARIANT, for example
`ARRAY_AGG(x)::VARIANT`, to receive its exact JSON text, or use
`format: "native"` for explicit driver conversion. Duplicate names require SQL
aliases or `rowMode: "array"`. Both errors suggest a fix in `details.nextStep`. Error messages
name a column only when its name is a plain identifier, and otherwise give its position: an
unaliased expression's column name is its SQL text, which can contain literals. Generic row
types are assertions; `decodeRow` can perform runtime validation.
`decodeRow` must be synchronous; a returned Promise is rejected. In JSON mode,
metadata-specific normalization preserves typed scalar SQL NULL without rewriting
text `"NULL"` or VARIANT JSON null. No driver-global conversion option is changed.
Native mode deliberately preserves the selected driver's behavior and quirks.

Materialization stops at 100,000 rows or 32 MiB of serialized decoded rows by
default. These are payload limits, not a strict bound on driver/network/heap
buffers. For larger results use `stream()`, a single-consumer async iterable;
break iteration or call `close()` to release its session.

`submit()` returns a process-local handle with `queryId`, `status()`, `result()`,
and `cancel()`. The first result call chooses its wait options; concurrent and
later calls share that promise. It never resubmits SQL. Completed materialized
results remain on the handle while the application retains it. Abandoned handles
are cancelled best-effort after the idle deadline.
Aborting the submission signal also disposes an unconsumed handle. A known terminal
server status remains available after cancellation; cancellation does not reverse execution.
`status()` reports the driver's server status, not local consumption success. A row
limit or decoder failure after confirmed execution leaves server status `SUCCESS`.
`BLOCKED` and unknown statuses remain pending until a terminal status or deadline.
After disposal without a known terminal state, status is unavailable rather than
queried through a destroyed connection. Cancelling a handle prevents pending local
result retrieval from continuing, but cannot prove the server query was cancelled.

Abort/deadline errors do not prove server cancellation or transaction rollback.
Submitted statements are never automatically replayed. Errors retain query IDs
and known/unknown completion; a `query()` or `stream()` deadline that expires before Snowflake
responds has no query ID yet, though the SDK still cancels the statement. `close()` stops new work, waits, then requests
cleanup; if the grace period expires it reports `SHUTDOWN_TIMEOUT`. Existing handles
may complete during that grace period. Bounded best-effort cleanup follows the grace
period and can add up to roughly 15 seconds for cancellation/status/destruction;
`timeoutMs` is not an overall wall-clock bound. No signal
handlers are installed. A user callback or driver authentication that never
settles may outlive a client deadline; the SDK cleans up late completion and
does not pretend the underlying operation was cancelled.

When Snowflake reports a query as failed, `details.errorCode` holds Snowflake's numeric error
code, such as `002003` for a missing or unauthorized object. Login and submission failures carry
the driver's code, and `sqlState` when present, the same way. Snowflake's message can quote SQL
literals, so it appears only in the error's `cause`: `console.error(error)` prints it, while the
error's `message` and `toJSON()` leave it out.

### Detached queries across requests and instances

Use this explicit path when an HTTP response or process can end before the query.
The submission request saves the reference and returns the query ID without
checking completion:

```ts
const reference = await client.submitDetached("SELECT CURRENT_USER() AS USER_NAME", {
  executionTimeoutMs: 60_000,
});
// Persist reference in trusted shared storage with the app's authorization record.
return Response.json({ status: "pending", queryId: reference.queryId }, { status: 202 });
```

The browser schedules later requests to the application's backend, passing the
query ID, not the full reference. Each authenticated request loads and authorizes
the shared record before calling:

```ts
const outcome = await client.pollQuery(authorizedRecord.reference, { signal: request.signal });
if (outcome.status === "complete") console.log(outcome.result.rows);
return Response.json(outcome, { status: outcome.status === "pending" ? 202 : 200 });
```

`pollQuery()` checks status once; it never sleeps or retries pending execution.
Pending returns HTTP 202 through the handler, and the browser schedules another
request. Success reads the completed result and returns HTTP 200. The initial
submission's `pending` means accepted, not an observed running status. Any backend
instance can handle a later request; no server polling loop, retained handle, or
original Serverless instance must survive scale-down.

For an export larger than the saved `maxRows` and `maxBytes`, such as a CSV download, call
`streamQuery()` instead. It checks status once like `pollQuery()` and returns the same pending
outcome. Success returns `{ status: "complete", queryId, stream }`: a single-consumer
`RowStream` in the saved format and row mode that reads every row, without those limits.

```ts
const outcome = await client.streamQuery(authorizedRecord.reference, { signal: request.signal });
if (outcome.status === "pending") return Response.json(outcome, { status: 202 });
for await (const row of outcome.stream) writeCsvRow(row); // The app's encoder and response body.
```

The stream holds its lookup connection, which counts toward `maxConnections`, until iteration
ends or breaks, `stream.close()` is called, the signal aborts, `consumeTimeoutMs` expires, or
client shutdown's grace period ends. None of these cancels the query. A failure partway throws
from iteration, so end the response with an error rather than as a complete file.
`examples/detached-http.ts` streams JSON lines and closes the stream when the client disconnects.

```ts
const status = await client.getQueryStatus(authorizedRecord.reference);
// Only when the user/application explicitly requests cancellation:
await client.cancelQuery(authorizedRecord.reference);
```

These five methods also exist on caller views and standalone query clients. Existing
`query()` and `handle.result()` behavior is unchanged: their wait timeouts still throw
and request cleanup, not pending.

`QueryReference` is serializable metadata: `version: 1`, `queryId`, ISO `submittedAt`,
`identity: { organization, account, user, role }`, `mode: "owner" | "caller"`, and
`results: { format, rowMode, maxRows, maxBytes, numbers? }`. `numbers` is saved only when it's
`"number"`, and a missing value means `"string"`, so references with default settings stay
readable by earlier versions. Organization and account are
server-reported names. The reference contains no credentials, SQL, or binds. It is
not signed and is not permission to read results. Do not pass browser-supplied
references directly to these methods.

Persist it with the application ID, authenticated application subject, authorization
mode, decoder policy, and expiry before returning the query ID. Authenticate and
authorize that shared record on every poll/stream/cancel. `examples/detached-http.ts` shows
the flow with an injected store, admission check, and versioned synchronous decoder.
It intentionally does not implement shared storage as an in-process Map.

Every poll/stream/status/cancel gets fresh credentials, opens a new connection, and
compares its server-reported organization/account, user, role, and owner/caller scope
with the reference. A mismatch raises `QUERY_IDENTITY_MISMATCH`; no role switching
or caller-to-owner fallback occurs. Detached caller methods require present caller
context even locally, unless `callerAsOwner: true` makes caller views owner scopes, which use
owner credentials and save owner references. Use a new caller view with trusted headers for each
request.

`DetachedQueryOptions` supports binds, warehouse, result settings, signal,
`acquireTimeoutMs`, `authTimeoutMs`, `submitTimeoutMs` (30 seconds by default), and
`executionTimeoutMs` (600 seconds by default). Submission setup/acknowledgement is
separate from server execution. The latter accepts integer milliseconds from 1,000
through 604,800,000 and rounds down to seconds; a lower effective statement limit
is retained, and warehouse/server policies may shorten it further. Submission
requires `ABORT_DETACHED_QUERY = FALSE` and `AUTOCOMMIT = TRUE`, otherwise
`DETACHED_QUERY_NOT_SUPPORTED`. The SDK does not override those policies.

`PollQueryOptions`, for `pollQuery()` and `streamQuery()`, supports `signal`,
acquisition/authentication timeouts, `lookupTimeoutMs` (30 seconds after login for identity,
status, and any result setup/initial fetch), `consumeTimeoutMs` (client default, otherwise
120 seconds; for a stream, counted from when `streamQuery()` returns), and synchronous
`decodeRow`. Status/cancel accept `QueryLookupOptions`: signal, acquisition/authentication,
and lookup timeouts. Saved result settings cannot be overridden during retrieval. Detached
`waitMs` and `pollIntervalMs` are rejected; there is no zero-I/O poll or server-side
availability wait.

Only an observed nonterminal status returns `{ status: "pending", queryId }`.
Success returns `{ status: "complete", queryId, result }` from `pollQuery()` and
`{ status: "complete", queryId, stream }` from `streamQuery()`. Pending checks skip
result-format setup and result fetching. Completed results still take time to
download, so configure request and consumption limits accordingly. Acquisition,
login, lookup, consumption, and cleanup are separate, not one total HTTP timeout.
Each retrieval reads from the beginning; the SDK does not persist partial results.
A partial result is never returned as complete.

Driver errors, lookup/consumption timeouts, conversion/limit failures, and terminal
query failures throw instead of returning pending. They do not cancel detached work.
`NO_QUERY_DATA` becomes `QUERY_UNAVAILABLE`, which can mean expired, inaccessible,
or unknown; the SDK cannot reliably distinguish these cases. A result-fetch failure
can still have `completion: "succeeded"`.

`cancelQuery()` checks status first and issues the public cancellation function with a
bound query ID only for an unfinished query. It resolves to `{ queryId, cancelled: true }`
when Snowflake confirms the cancellation, or when a status check afterward shows the query
cancelled: `FAILED_WITH_ERROR` with error `000604`, which is how Snowflake reports a
cancelled query, or `ABORTED`. Otherwise it resolves to `{ queryId, cancelled: false, status }`
with the terminal status observed: the query had already finished, including after an earlier
cancellation, or it finished before the cancellation took effect, for example with `SUCCESS`
or a statement timeout (`FAILED_WITH_ERROR` with error `000630`). Record a job as cancelled
only when `cancelled` is true. If the query still appears to be running after an unconfirmed
request, it throws `QUERY_FAILED`, with Snowflake's `errorCode` when Snowflake refused the request;
cancelling a caller's query needs a caller grant described in [Caller Context](#caller-context).
It does not guarantee rollback or that an in-progress cancellation has completed.

```ts
const { cancelled } = await client.cancelQuery(authorizedRecord.reference);
```

Detached connections never enter the reusable pool. They set
`serverSessionKeepAlive: true` and no client heartbeat. After submission acknowledgement,
request abort and `close()` release local resources without cancelling server work.
Before acknowledgement, cancellation is best effort and the outcome can be unknown.
Lookup/cancel connections also avoid deleting server sessions. Ordinary connections
and native-options factory defaults keep their previous cleanup behavior.

The SDK destroys local readers/connections and observes late callbacks, but the
pinned driver can retain in-flight chunk downloads after stream destruction. Cleanup
is not proof that all driver background activity stopped. Retained Snowflake sessions
follow server policies, and running queries continue consuming credits. Local connection
limits do not cap distributed detached jobs or retained server sessions; the application
owns those quotas. This is one self-contained statement, not a transaction/session
continuation or support for file transfers/independently spawned background work.

Application expiry is independent of Snowflake result retention. Store results elsewhere
for longer retention. There is an unavoidable crash window between acknowledgement and
durable record storage; this SDK does not provide exactly-once registration or SQL replay.
After registration, the server need not stay active between browser requests. Closing
the browser stops polling, not the Snowflake query; cancellation must be explicit.
Live SPCS/Serverless owner/caller, replica/restart, multi-user, cancellation, policy, and expiry
qualification remains required. Offline tests do not establish those platform guarantees.

## Secrets and REST

```ts
const apiKey = await client.secrets.getString("API_KEY");
const login = await client.secrets.getPassword("SERVICE_LOGIN");
const token = await client.secrets.getAccessToken("PARTNER_API");
const response = await client.fetch("/api/v2/warehouses");
if (!response.ok) {
  await response.body?.cancel();
  throw new Error(`Account API returned HTTP ${response.status}`);
}
const warehouses = await response.json();
```

Secret-only use does not load or authenticate the SQL driver. Mounts under
`/secrets/<name>/` take precedence over `SNOWFLAKE_SECRET_<NAME>_*` environment
values. String/password contents are preserved. Empty mounts fail closed because
they may indicate revocation; they never fall back to stale environment values.
Username/password must come from one source. Platform updates are atomic per
file, not necessarily as a pair, so this cannot guarantee a consistent pair
during concurrent platform rotation.

Local OAuth uses the client-credentials grant, not refresh tokens. Configure
`OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and optional
`OAUTH_SCOPE` under the same prefix. Concurrent acquisition is coalesced;
responses without `expires_in` are not cached. `ACCESS_TOKEN` supports static
local tokens. Mounted tokens are reopened on every read.
OAuth endpoint, client credentials, scope, and static-token changes invalidate prior
cache/inflight ownership. Expiry is measured conservatively from acquisition start.
A revoked/removed mounted source does not restore an environment fallback after the
mount has been observed. Shutdown clears the SDK's token cache.

`client.fetch()` currently supports OAuth/PAT source credentials only and returns a standard
Response-compatible object. Supply an account-relative path, not an absolute
URL. Authentication headers and redirects are restricted. Password/SSO/key-pair
SQL connectivity does not imply REST support. HTTP uses an explicit environment
proxy agent and Node's TLS trust, including startup `NODE_EXTRA_CA_CERTS`.
Do not disable certificate verification.

Each request has a deadline of 120 seconds by default. Set `timeouts.httpMs` on the client to change
the default, or pass `timeoutMs` with a request to override it for that request; both take whole
milliseconds. The deadline is combined with—not replaced by—the caller signal, and it remains active
while reading the response body, so raise it for long streaming responses such as server-sent
events:

```ts
const response = await client.fetch(path, { method: "POST", body, timeoutMs: 15 * 60_000 });
```

If the deadline expires before the response arrives, `fetch()` rejects with `TIMEOUT`; after that,
reading the body fails with a `TimeoutError`. Network, DNS, and TLS failures reject with
`HTTP_FAILED`, keeping the underlying error as the non-serialized `cause`. Invalid proxy settings
fail without a cause, because proxy URLs can contain credentials. Consume or cancel every body; HTTP
status codes are not automatically thrown or retried. Shutdown aborts outstanding HTTP
requests/bodies immediately while SQL operations receive their grace period.

Use `client.asCaller({ headers }).fetch(path, init)` for caller-scoped requests.
This pre-release API replaces `client.rest.fetch()` with `client.fetch()`; no `rest`
namespace or compatibility alias is retained. Response handling, deadlines, account
restriction, and caller identity rules are unchanged.

## Diagnostics and Driver Injection

`await client.diagnostics()` reports environment evidence, provider selection,
and resource counts without acquiring credentials. It may invoke a supplied structural
provider's optional diagnostic hook, which must also be redacted and non-authenticating.
Without that hook, source information is unknown. Unprobed sources are not claimed to work.

Pass a `logger` to `createSarClient()`, or to `createConnectionOptions()` for standalone
components, to receive an event for each SQL login and query. For example, to print a line for
each:

```ts
const client = createSarClient({
  logger: (event) => console.log("[snowflake]", JSON.stringify(event)),
});
```

- `session-opened`: a new SQL session logged in, with `mode` (`"owner"` or `"caller"`) and
  `durationMs` from acquiring credentials through login. Reusing a session logs nothing.
- `query-succeeded`: a statement finished, with `queryId`, `durationMs`, and `rowCount`, the number
  of rows returned. `stream()` and `streamQuery()` log it when they return the stream, without
  `rowCount`.
- `query-failed`: the operation failed, with `code`, the SDK error code; `errorCode`, Snowflake's
  numeric error code, when it reported one; `queryId` when known; and `durationMs`.
- `caller-fallback`: a caller view without caller context used owner credentials. It's logged once
  per factory, with `environment`.
- `profile-keys-ignored`: the selected connection profile has keys the SDK doesn't use, with their
  names in `keys`.

Query events come from `query()`, `stream()`, `tx.query()`, `pollQuery()`, `streamQuery()`, and
`submit()` handles, whose `result()` logs success. `durationMs` is whole milliseconds since the
call, or since `submit()` for a handle, including acquiring a session. Detached submission, status
checks, cancellation, and pending polls log nothing, and neither do the sessions detached
operations open. Events never contain SQL text, binds, rows, credentials, profile values, file
paths, or driver or Snowflake error messages. A logger that throws or rejects doesn't affect the operation. A custom
options provider has no logger, so the components that use it log nothing.

Underlying error causes may contain sensitive driver content; do not return them to clients or
serialize them automatically. The SDK adds no telemetry; the Node driver's own logging and
telemetry behavior remain separate. The driver logs several lines at its default `INFO`
level for each new connection, and operations use a new connection by default. To change
its level, configure the module you inject:

```ts
import snowflake from "snowflake-sdk";
snowflake.configure({ logLevel: "ERROR" });
const client = createSarClient({ driver: snowflake });
```

The injected module is authoritative. The default driver is loaded only when
needed, never configured globally by the SDK. The tested baseline is 3.4.0;
other versions are not yet claimed compatible. Root types are SDK-owned except
the explicit bind/driver integration boundaries. Advanced raw connection types
are also exported from `@snowflake/sar-sdk/driver`.

## Validation Status

The repository checks synthetic driver behavior, real pinned-driver conversion
contracts, cancellation races, auth/secret boundaries, source/public types, and
installed ESM/CommonJS consumers. The [examples](https://github.com/snowflakedb/sar-sdk/tree/main/nodejs/examples) compile
against public exports. None of those checks executes SQL or acquires real credentials.

The options-based components have not been live-qualified. Serverless/preview,
fresh-session SSO/MFA, broader RBAC/proxy/CA coverage, real OAuth/secret rotation,
load, and deployment packaging still need qualification. Other driver major versions
and Node 20 are not supported. See the [release checklist](https://github.com/snowflakedb/sar-sdk/blob/main/nodejs/CONTRIBUTING.md#release-checklist).

Inheriting another tool's active connection or session/master tokens requires a
supported platform contract. Inherited sessions are deliberately rejected rather
than silently shared, mutated, refreshed, or logged out. Shared configuration
does not guarantee the connection currently selected in another tool. PUT/GET/file-transfer and
other multi-statement session workflows should use the advanced driver callback; the normal
query/stream/submit API is for single row-producing statements, and `transaction()` runs them in
one transaction.

## API at a glance

| API                                                         | Contract                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `createSarClient(options?)`                                 | Synchronous lazy factory                                     |
| `client.connect()`                                          | Temporary owned-session readiness check                      |
| `client.query<Row>(sql, options?)`                          | Materialized rows, query ID, columns, returned-row count     |
| `client.submit<Row>(sql, options?)`                         | Process-local handle; `status()`, `result()`, `cancel()`     |
| `client.stream<Row>(sql, options?)`                         | Single-consumer async iterable; explicit `close()`           |
| `client.transaction(callback, options?)`                    | One session; serialized `tx.query()`; COMMIT or ROLLBACK     |
| `client.asCaller({ headers })` or `({ token })`             | Immutable request-scoped subset                              |
| `client.withConnection(callback)`                           | Awaited raw-driver callback and automatic disposal           |
| `client.asCaller({ headers }).withConnection(callback)`     | Raw-driver callback with the caller's identity               |
| `client.secrets.getString/getPassword/getAccessToken(name)` | Async mount/environment/provider resolution                  |
| `client.fetch(path, init?)`                                 | Account-relative authenticated HTTP; caller owns body        |
| `client.diagnostics()`                                      | Async evidence/selection/budget snapshot, not a health probe |
| `client.close({ timeoutMs }?)`                              | Idempotent stop-admission, SQL grace period, cleanup         |

Root exports include SDK types and `SarError`/`isSarError`. `/auth` exports provider
helpers and credential types; `/driver` exposes Node-driver integration types.
No internal file path is a supported import. Source JSDoc and declarations are the
API reference; internal files and test fixtures may change without compatibility guarantees.

## License

Copyright (c) Snowflake Inc. All rights reserved.

Licensed under the Apache 2.0 license.
