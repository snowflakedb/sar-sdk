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

# Examples

These server-side examples import the public API and are typechecked by `npm run typecheck`.
`npm run test:package` also compiles them against an installed tarball in both
NodeNext and Bundler resolution modes, without source-path aliases.
They export functions rather than running at import time. Routine tests do not execute SQL,
open a browser, read real credentials, or call the account APIs.

- `query.ts`: named local profile, binds, cancellation, safe errors, and shutdown.
- `caller.ts`: request-scoped caller views and one-off raw caller connections.
- `operations.ts`: explicit connection options from a rotating token getter, handles, transactions, streams, and HTTP response ownership.
- `detached-http.ts`: submit/poll/download/cancel handlers with an injected durable shared store,
  application authorization, job admission, expiry, and a versioned decoder. Each request
  selects a fresh caller view. Submit persists the reference and returns HTTP 202 with a
  query ID, without a status check. The browser schedules polling requests; each checks
  Snowflake once and returns pending or a completed result. Download streams a completed
  result as JSON lines without the saved row and byte limits, and closes the stream if the
  client disconnects. Any instance can handle the next request after Serverless scale-down.
  Records contain metadata, never credentials; HTTP clients receive only query IDs and
  results. Store failure requests cancellation. A process crash before registration still
  has an unknown outcome; no SQL replay is attempted.
- `composition.ts`: independent components, shared options-provider ownership, awaited native driver
  callbacks, and a narrowly scoped reset contract for optional reuse.
- `native-options.ts`: direct driver connection and native pool snapshots, with explicit
  completion/cleanup and the credential-rotation limitation.

Invoke them explicitly from a configured Node.js application. The `dev` profile,
account identifier, and token path are illustrative. Do not put credentials in examples.
Detached-query use on SPCS/Serverless still requires live qualification. Lookup and result
consumption have separate timeouts; acquisition/login/cleanup add time. Downloading a
completed result must fit the application's request budget. These are server handlers,
not browser utilities; applications implement the browser polling loop today.
