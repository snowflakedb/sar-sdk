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

import { createHash } from "node:crypto";
import type snowflake from "snowflake-sdk";
import { callerToken } from "./caller.js";
import { endpoint } from "./config.js";
import { fail, keys, nextSteps, SarError } from "./errors.js";
import type { CallerContext } from "./types.js";

export type NativeConnectionOptions = snowflake.ConnectionOptions;
/** Trusted application dependency. Returned native options contain credentials. */
export interface ConnectionOptionsProvider {
  getOwnerOptions(): NativeConnectionOptions;
  /** The caller's token, taken from the sf-context-current-user-token header. */
  getCallerOptions(token: string): NativeConnectionOptions;
}
export interface ConnectionOptionsFactoryOptions {
  /**
   * Run caller views and getCallerOptions() as the owner, even when caller context is present.
   * The SDK doesn't detect when: pass the app's own condition, such as
   * `process.env.NODE_ENV === "development"`. Default: false.
   */
  callerAsOwner?: boolean;
}

// Non-enumerable and immutable, but shared by mixed ESM/CJS consumers, like connection scopes.
const callerAsOwnerKey = Symbol.for("@snowflake/sar-sdk/caller-as-owner/v1");
// The driver sends `token` in the login only for these authenticators.
const tokenAuthenticators = ["OAUTH", "PROGRAMMATIC_ACCESS_TOKEN"];
const runsCallersAsOwner = (provider: object) =>
  (provider as Record<symbol, unknown>)[callerAsOwnerKey] === true;

function freezeProvider<T extends object>(provider: T, callerAsOwner: boolean): Readonly<T> {
  if (callerAsOwner) Object.defineProperty(provider, callerAsOwnerKey, { value: true });
  return Object.freeze(provider);
}

/**
 * Native options from explicit connection options. Nothing is read until an option getter runs, so
 * a `token` getter on the connection options (see fromPlatform) can rotate. Caller options append
 * the caller's token to the `token` of an OAUTH or PROGRAMMATIC_ACCESS_TOKEN connection, the only
 * authenticators whose login sends it, and throw AUTH_NOT_SUPPORTED for any other.
 */
export function createConnectionOptions(
  connection: NativeConnectionOptions,
  input: ConnectionOptionsFactoryOptions = {},
): ConnectionOptionsProvider {
  keys(input, ["callerAsOwner"], "connection options");
  if (input.callerAsOwner !== undefined && typeof input.callerAsOwner !== "boolean")
    fail("INVALID_OPTIONS", "callerAsOwner must be a boolean");
  if (!connection || typeof connection !== "object" || Array.isArray(connection))
    fail("INVALID_OPTIONS", "Connection options must be an object");
  const callerAsOwner = input.callerAsOwner === true;
  // Copy descriptors, not values, so a getter keeps reading the current value.
  const source = Object.defineProperties(
    {} as Record<string, unknown>,
    Object.getOwnPropertyDescriptors(connection),
  );
  function owner(): NativeConnectionOptions {
    const target: Record<string, unknown> = {};
    for (const key of ["account", "host", "accessUrl", "port", "protocol", "region"] as const)
      if (key in source) target[key] = source[key];
    const accessUrl = endpoint(target);
    return {
      ...source,
      accessUrl,
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
      serverSessionKeepAlive: false,
    } as NativeConnectionOptions;
  }
  return freezeProvider(
    {
      getOwnerOptions: owner,
      getCallerOptions(token: string) {
        if (typeof token !== "string" || !token.trim())
          fail("CALLER_CONTEXT_REQUIRED", "Caller token cannot be empty");
        const options = owner();
        if (callerAsOwner) return options;
        // Other authenticators ignore `token`, so a composed token would be dropped and the
        // session would log in as the owner.
        if (
          !tokenAuthenticators.includes(String(options.authenticator ?? "SNOWFLAKE").toUpperCase())
        )
          throw new SarError(
            "AUTH_NOT_SUPPORTED",
            "Caller options need an OAUTH or PROGRAMMATIC_ACCESS_TOKEN connection, whose login sends the token; this connection's authenticator doesn't",
            { nextStep: nextSteps.callerToken },
          );
        if (typeof options.token !== "string" || !options.token)
          throw new SarError(
            "AUTH_NOT_SUPPORTED",
            "Caller options need the connection's token to append the caller's token to; set callerAsOwner: true to run callers with owner credentials",
            { nextStep: nextSteps.callerToken },
          );
        return { ...options, token: `${options.token}.${token}` };
      },
    },
    callerAsOwner,
  );
}

/** Rejects every call; the default when a component is given no connection options. */
export const unconfiguredOptions: ConnectionOptionsProvider = Object.freeze({
  getOwnerOptions: () => fail("AUTH_NOT_FOUND", unconfigured),
  getCallerOptions: () => fail("AUTH_NOT_FOUND", unconfigured),
});
const unconfigured =
  "No connection options configured. Pass connectionOptions: createConnectionOptions(...).";

/** Snapshot methods with receivers; structural providers are trusted code, not branded objects. */
export function snapshotProvider(provider: ConnectionOptionsProvider): ConnectionOptionsProvider {
  if (
    !provider ||
    typeof provider.getOwnerOptions !== "function" ||
    typeof provider.getCallerOptions !== "function"
  )
    fail("INVALID_OPTIONS", "connectionOptions must implement owner and caller options getters");
  return freezeProvider(
    {
      getOwnerOptions: provider.getOwnerOptions.bind(provider),
      getCallerOptions: provider.getCallerOptions.bind(provider),
    },
    runsCallersAsOwner(provider),
  );
}

/**
 * A new immutable identity scope for each caller view, even with identical tokens. Views of a
 * callerAsOwner provider are owner scopes, but their caller context is still validated.
 */
export function optionsScope(provider: ConnectionOptionsProvider, context?: CallerContext) {
  const token = context === undefined ? undefined : callerToken(context);
  if (token === undefined || runsCallersAsOwner(provider))
    return Object.freeze({
      options: () => snapshotNativeOptions(provider.getOwnerOptions()),
      mode: "owner" as const,
      contextKey: undefined,
    });
  if (token === null)
    throw new SarError("CALLER_CONTEXT_REQUIRED", "Caller context carries no caller token", {
      nextStep: nextSteps.callerContext,
    });
  return Object.freeze({
    mode: "caller" as const,
    /** A digest of the caller token that groups views made from the same token. */
    contextKey: createHash("sha256").update(token).digest("base64url"),
    options: () => snapshotNativeOptions(provider.getCallerOptions(token)),
  });
}

function snapshotNativeOptions(input: NativeConnectionOptions): NativeConnectionOptions {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("AUTH_FAILED", "Options provider must return native connection options");
  const options = { ...input };
  const fields = options as Record<string, unknown>;
  if (
    ["sessionToken", "masterToken", "session_token", "master_token"].some(
      (key) => fields[key] !== undefined,
    )
  )
    fail(
      "AUTH_NOT_SUPPORTED",
      "Inherited session credentials are not supported by owned components",
    );
  if (options.authenticator !== undefined && typeof options.authenticator !== "string")
    fail("AUTH_FAILED", "Options provider returned an invalid authenticator");
  endpoint(options);
  return options;
}
