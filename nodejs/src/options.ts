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

import { defined, duration, fail, keys, positive, signalOption } from "./errors.js";
import type {
  QueryOptions,
  SarClientOptions,
  ConnectionOptions,
  Environment,
  Platform,
  DriverOptions,
  LogEvent,
  TransactionOptions,
  TransactionQueryOptions,
} from "./types.js";
import type { AuthProvider } from "./auth-manager.js";

/** Internal resolution settings, not the public aggregate configuration. */
export interface ResolutionOptions {
  connection?: ConnectionOptions;
  environment?: Environment;
  platform?: Platform;
  auth?: {
    interactive?: "auto" | "always" | "never";
    callerFallback?: "auto" | "error";
    callerAsOwner?: boolean;
    profileEnvironmentOverrides?: boolean;
    providers?:
      readonly AuthProvider[] | ((defaults: readonly AuthProvider[]) => readonly AuthProvider[]);
  };
  timeouts?: SarClientOptions["timeouts"];
  driverOptions?: DriverOptions;
  logger?: (event: LogEvent) => void;
}
type InternalOptions = Pick<
  SarClientOptions,
  "connectionOptions" | "pool" | "timeouts" | "results" | "secrets" | "driver"
> &
  ResolutionOptions;

export type ResolvedQuery = QueryOptions &
  Required<Pick<QueryOptions, "format" | "rowMode" | "maxRows" | "maxBytes" | "numbers">>;
const queryKeys = [
  "binds",
  "warehouse",
  "signal",
  "acquireTimeoutMs",
  "authTimeoutMs",
  "waitTimeoutMs",
  "consumeTimeoutMs",
  "pollIntervalMs",
  "format",
  "rowMode",
  "maxRows",
  "maxBytes",
  "numbers",
  "decodeRow",
];
const sessionKeys = ["format", "warehouse", "acquireTimeoutMs", "authTimeoutMs"];
const driverKeys = [
  "clientStoreTemporaryCredential",
  "credentialCacheDir",
  "clientRequestMFAToken",
  "browserActionTimeout",
  "openExternalBrowserCallback",
  "proxyHost",
  "proxyPort",
  "proxyProtocol",
  "proxyUser",
  "proxyPassword",
  "noProxy",
];

export function queryOptions(
  defaults: SarClientOptions["results"],
  provided: QueryOptions = {},
): ResolvedQuery {
  keys(provided, queryKeys, "query");
  const result = {
    format: "json",
    rowMode: "object",
    maxRows: 100_000,
    maxBytes: 32 * 1024 * 1024,
    numbers: "string",
    ...defined(defaults ?? {}),
    ...defined(provided),
  } as ResolvedQuery;
  if (!["json", "native"].includes(result.format) || !["object", "array"].includes(result.rowMode))
    fail("INVALID_OPTIONS", "Invalid result format or row mode");
  if (!["string", "number"].includes(result.numbers))
    fail("INVALID_OPTIONS", "numbers must be 'string' or 'number'");
  for (const key of [
    "acquireTimeoutMs",
    "authTimeoutMs",
    "waitTimeoutMs",
    "consumeTimeoutMs",
    "pollIntervalMs",
  ] as const)
    duration(result[key], key);
  for (const key of ["maxRows", "maxBytes"] as const) {
    positive(result[key], key);
    if (!Number.isSafeInteger(result[key]))
      fail("INVALID_OPTIONS", `${key} must be a safe integer`);
  }
  signalOption(result.signal);
  if (
    result.warehouse !== undefined &&
    (typeof result.warehouse !== "string" || !result.warehouse.trim())
  )
    fail("INVALID_OPTIONS", "warehouse must be a nonempty string");
  if (result.decodeRow !== undefined && typeof result.decodeRow !== "function")
    fail("INVALID_OPTIONS", "decodeRow must be a function");
  return result;
}

export function transactionOptions(
  defaults: SarClientOptions["results"],
  provided: TransactionOptions = {},
): ResolvedQuery {
  keys(provided, ["signal", ...sessionKeys], "transaction");
  return queryOptions(defaults, provided);
}

export function transactionQueryOptions(
  transaction: ResolvedQuery,
  provided: TransactionQueryOptions = {},
): ResolvedQuery {
  keys(
    provided,
    queryKeys.filter((key) => !sessionKeys.includes(key)),
    "transaction query",
  );
  const { format, rowMode, maxRows, maxBytes, numbers, warehouse } = transaction;
  return { ...queryOptions({ format, rowMode, maxRows, maxBytes, numbers }, provided), warehouse };
}

const factorySettings = [
  "connection",
  "environment",
  "platform",
  "interactive",
  "callerFallback",
  "callerAsOwner",
  "driverOptions",
  "logger",
] as const;

export function clientOptions(input: SarClientOptions): InternalOptions {
  keys(
    input,
    ["connectionOptions", "pool", "timeouts", "results", "secrets", "driver", ...factorySettings],
    "client",
  );
  const supplied = factorySettings.find((key) => input[key] !== undefined);
  if (supplied && input.connectionOptions !== undefined)
    fail(
      "INVALID_OPTIONS",
      `${supplied} cannot be combined with connectionOptions; configure the supplied provider instead`,
    );
  const { interactive, callerFallback, callerAsOwner, ...rest } = input;
  return internalOptions({ ...rest, auth: { interactive, callerFallback, callerAsOwner } });
}

export function internalOptions(input: InternalOptions): InternalOptions {
  keys(
    input,
    [
      "connection",
      "environment",
      "platform",
      "auth",
      "connectionOptions",
      "pool",
      "timeouts",
      "results",
      "secrets",
      "driver",
      "driverOptions",
      "logger",
    ],
    "client",
  );
  keys(
    input.connection === undefined ? {} : input.connection,
    [
      "name",
      "configFile",
      "account",
      "host",
      "accessUrl",
      "username",
      "warehouse",
      "database",
      "schema",
      "role",
    ],
    "connection",
  );
  keys(
    input.auth === undefined ? {} : input.auth,
    ["interactive", "callerFallback", "callerAsOwner", "profileEnvironmentOverrides", "providers"],
    "auth",
  );
  keys(
    input.pool === undefined ? {} : input.pool,
    [
      "maxConnections",
      "maxQueue",
      "acquireTimeoutMs",
      "handleIdleTimeoutMs",
      "mode",
      "reset",
      "idleTimeoutMs",
      "maxLifetimeMs",
      "resetTimeoutMs",
    ],
    "pool",
  );
  keys(
    input.timeouts === undefined ? {} : input.timeouts,
    ["authMs", "waitMs", "consumeMs", "closeMs", "httpMs"],
    "timeouts",
  );
  keys(
    input.results === undefined ? {} : input.results,
    ["format", "rowMode", "maxRows", "maxBytes", "numbers"],
    "results",
  );
  keys(
    input.secrets === undefined ? {} : input.secrets,
    ["directory", "envPrefix", "providers"],
    "secrets",
  );
  keys(input.driverOptions === undefined ? {} : input.driverOptions, driverKeys, "driverOptions");
  for (const [key, value] of Object.entries(input.connection ?? {}))
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      fail("INVALID_OPTIONS", `${key} must be a nonempty string`);
  for (const [key, value] of Object.entries(input.timeouts ?? {})) duration(value, key);
  if (input.timeouts?.httpMs !== undefined && !Number.isInteger(input.timeouts.httpMs))
    fail("INVALID_OPTIONS", "httpMs must be an integer");
  for (const key of ["acquireTimeoutMs", "handleIdleTimeoutMs"] as const)
    duration(input.pool?.[key], key);
  if (input.pool?.mode !== undefined && !["isolated", "reusable"].includes(input.pool.mode))
    fail("INVALID_OPTIONS", "Invalid pool mode");
  if (input.pool?.mode === "reusable") {
    if (typeof input.pool.reset !== "function")
      fail("INVALID_OPTIONS", "Reusable sessions require an async reset hook");
    for (const key of ["idleTimeoutMs", "maxLifetimeMs", "resetTimeoutMs"] as const)
      duration(input.pool[key], key);
  } else if (
    ["reset", "idleTimeoutMs", "maxLifetimeMs", "resetTimeoutMs"].some(
      (key) => (input.pool as Record<string, unknown> | undefined)?.[key] !== undefined,
    )
  ) {
    fail("INVALID_OPTIONS", "Reuse settings require reusable pool mode");
  }
  for (const key of ["maxConnections", "maxQueue"] as const) {
    const value = input.pool?.[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (key === "maxQueue" ? 0 : 1))
    )
      fail("INVALID_OPTIONS", `${key} must be a valid integer capacity`);
  }
  for (const [value, choices, label] of [
    [input.environment, ["auto", "local", "preview", "deployed"], "environment"],
    [input.platform, ["auto", "spcs", "serverless"], "platform"],
    [input.auth?.interactive, ["auto", "always", "never"], "interactive"],
    [input.auth?.callerFallback, ["auto", "error"], "callerFallback"],
  ] as const)
    if (value !== undefined && !(choices as readonly unknown[]).includes(value))
      fail("INVALID_OPTIONS", `Invalid ${label}`);
  if (input.logger !== undefined && typeof input.logger !== "function")
    fail("INVALID_OPTIONS", "logger must be a function");
  for (const key of ["callerAsOwner", "profileEnvironmentOverrides"] as const)
    if (input.auth?.[key] !== undefined && typeof input.auth[key] !== "boolean")
      fail("INVALID_OPTIONS", `${key} must be a boolean`);
  for (const [key, value] of Object.entries(input.driverOptions ?? {})) {
    if (value === undefined) continue;
    if (["clientStoreTemporaryCredential", "clientRequestMFAToken"].includes(key)) {
      if (typeof value !== "boolean") fail("INVALID_OPTIONS", `${key} must be a boolean`);
    } else if (key === "openExternalBrowserCallback") {
      if (typeof value !== "function") fail("INVALID_OPTIONS", `${key} must be a function`);
    } else if (key === "browserActionTimeout") duration(value as number, key);
    else if (key === "proxyPort") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
        fail("INVALID_OPTIONS", "Invalid proxyPort");
    } else if (typeof value !== "string") fail("INVALID_OPTIONS", `${key} must be a string`);
  }
  if (
    input.driver !== undefined &&
    (!input.driver || typeof input.driver.createConnection !== "function")
  )
    fail("INVALID_OPTIONS", "driver must implement createConnection");
  const options = {
    ...input,
    connection: { ...input.connection },
    auth: { ...input.auth },
    pool: { ...input.pool } as SarClientOptions["pool"],
    timeouts: { ...input.timeouts },
    results: { ...input.results },
    secrets: { ...input.secrets },
    driverOptions: defined({ ...input.driverOptions }),
  };
  if (input.driver)
    options.driver = { createConnection: input.driver.createConnection.bind(input.driver) };
  if (input.pool?.mode === "reusable" && options.pool?.mode === "reusable")
    options.pool.reset = input.pool.reset.bind(input.pool);
  queryOptions(options.results);
  return options;
}
