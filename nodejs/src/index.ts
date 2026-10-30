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

export { createSarClient } from "./sar-client.js";
export type { CallerClient, SarClient, SarClientOptions } from "./sar-client.js";
export { getCallerUserToken } from "./connection-options/index.js";
export type { CallerContext, HeaderReader } from "./connection-options/caller.js";
export { SarError, isSarError } from "./core/errors.js";
export type { SarErrorCode, CompletionState } from "./core/errors.js";
export type { CloseOptions, LogEvent } from "./core/lifecycle.js";
export type { TimeoutOptions } from "./core/timeouts.js";
export type {
  ClientDiagnostics,
  ConnectionManager,
  ConnectionManagerOptions,
  ConnectionScope,
  DriverModule,
  DriverPoolOptions,
  PoolOptions,
} from "./connection-manager/connection-manager.js";
export type {
  FetchClient,
  FetchClientOptions,
  FetchInit,
  FetchScope,
} from "./fetch-client/fetch-client.js";
export type {
  DetachedQueryOptions,
  DetachedQueryScope,
  PollQueryOptions,
  QueryCancellation,
  QueryClient,
  QueryClientOptions,
  QueryHandle,
  QueryIdentity,
  QueryLookupOptions,
  QueryOptions,
  QueryPollResult,
  QueryReference,
  QueryResult,
  QueryScope,
  QueryStreamResult,
  RowStream,
  ScopedQueryClient,
  Transaction,
  TransactionOptions,
  TransactionQueryOptions,
} from "./query-client/index.js";
export type {
  PasswordSecret,
  SecretProvider,
  Secrets,
  SecretsClient,
  SecretsOptions,
} from "./secrets-client/secrets-client.js";
export type { Binds, ResultOptions } from "./query-client/query-options.js";
export type { ColumnMetadata } from "./query-client/results.js";
