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

import { duration, fail, keys } from "../core/errors.js";
import { timeoutOptions } from "../core/timeouts.js";
import type { ConnectionManagerOptions } from "./connection-manager.js";

/** Driver pool settings the SDK derives, with what to configure instead. */
const sdkPoolKeys = {
  max: "use pool.maxConnections",
  min: "pooled sessions open on demand",
  acquireTimeoutMillis: "use pool.acquireTimeoutMs",
  maxWaitingClients: "use pool.maxQueue",
  idleTimeoutMillis: "use pool.idleTimeoutMs",
};

/** Validates connection manager options and returns a copy that holds no caller references. */
export function connectionOptions(input: ConnectionManagerOptions): ConnectionManagerOptions {
  keys(input, ["pool", "timeouts", "driver", "logger"], "connection manager");
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
      "driverPoolOptions",
    ],
    "pool",
  );
  const timeouts = timeoutOptions(input.timeouts);
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
  const driverPool: unknown = input.pool?.driverPoolOptions;
  if (driverPool !== undefined) {
    if (!driverPool || typeof driverPool !== "object" || Array.isArray(driverPool))
      fail("INVALID_OPTIONS", "driverPoolOptions must be an object");
    for (const [key, replacement] of Object.entries(sdkPoolKeys))
      if (key in driverPool)
        fail("INVALID_OPTIONS", `driverPoolOptions.${key} is set by the SDK; ${replacement}`);
  }
  for (const key of ["maxConnections", "maxQueue"] as const) {
    const value = input.pool?.[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (key === "maxQueue" ? 0 : 1))
    )
      fail("INVALID_OPTIONS", `${key} must be a valid integer capacity`);
  }
  if (input.logger !== undefined && typeof input.logger !== "function")
    fail("INVALID_OPTIONS", "logger must be a function");
  if (
    input.driver !== undefined &&
    (!input.driver || typeof input.driver.createPool !== "function")
  )
    fail("INVALID_OPTIONS", "driver must implement createPool");
  const options: ConnectionManagerOptions = {
    ...input,
    pool: { ...input.pool } as ConnectionManagerOptions["pool"],
    timeouts,
  };
  if (input.driver) options.driver = { createPool: input.driver.createPool.bind(input.driver) };
  if (input.pool?.mode === "reusable" && options.pool?.mode === "reusable")
    options.pool.reset = input.pool.reset.bind(input.pool);
  if (input.pool?.driverPoolOptions && options.pool)
    options.pool.driverPoolOptions = { ...input.pool.driverPoolOptions };
  return options;
}
