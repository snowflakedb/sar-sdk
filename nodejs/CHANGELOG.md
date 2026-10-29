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

# Changelog

## Unreleased

- **Breaking:** make `createConnectionOptions(connection, { callerAsOwner? })` take the driver's
  connection options and nothing else, and return synchronous `getOwnerOptions()` and
  `getCallerOptions(token)`. Caller options always append the caller's token to the `token` of an
  `OAUTH` or `PROGRAMMATIC_ACCESS_TOKEN` connection, and throw `AUTH_NOT_SUPPORTED` for any other
  authenticator or a missing `token` unless `callerAsOwner` is true. A caller view
  without a caller token throws `CALLER_CONTEXT_REQUIRED`. Remove `AuthProvider`, `AuthManager`,
  `fromCredentials`, `fromTokenFile`, `fromEnvironment`, the provider array and its fallbacks,
  environment and platform detection, `callerFallback`, `interactive`, `driverOptions`,
  `timeouts.authMs`, the factory's `logger`, `diagnostics()`, and `close()`, and the
  `caller-fallback` and `profile-keys-ignored` log events. `fromToml()` and
  `fromPlatform()` now read their source and return connection options, `fromToml()`
  applies no `SNOWFLAKE_*` overrides, `fromPlatform()` reads `/snowflake/session/token` on both
  SPCS and Serverless, and a token read from a file is a getter that picks up a
  rotated token. Add `fromDefault()`, which takes no options and uses `fromPlatform()` when that
  token is mounted and the default `fromToml()` profile otherwise, so an app needs no `NODE_ENV`
  check to choose a source. `createSarClient()` takes `connectionOptions` and `logger` and no connection
  settings, and `diagnostics()` reports only the session mode and connection counts.
- Every session now comes from the Node driver's connection pools (`createPool`) instead of the
  SDK's own pool. The new `pool.driverPoolOptions` passes any driver pool option through
  unchanged, except the size, wait, and idle-timeout settings the SDK sets from `maxConnections`,
  `maxQueue`, `acquireTimeoutMs`, and `idleTimeoutMs`.
- **Breaking:** an injected `driver` must implement `createPool` instead of `createConnection`,
  and `AUTH_FAILED` from a failed login no longer has `details.errorCode`, because the driver's
  pool reports login failures by message only.

## 0.1.0-dev.1

Initial development version of the SDK. Not published to npm.
