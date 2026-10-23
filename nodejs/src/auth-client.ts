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
import { AuthManager, credentialOptions, type AuthProvider } from "./auth-manager.js";
import { callerToken } from "./caller.js";
import { detect, endpoint, selectedName, type Detected } from "./config.js";
import { duration, fail, keys, signalOption } from "./errors.js";
import { checkAbort, deadline } from "./lifecycle.js";
import { internalOptions } from "./options.js";
import type {
  CallerContext,
  ConnectionOptions,
  DriverOptions,
  Environment,
  LogEvent,
  Platform,
} from "./types.js";

export type NativeConnectionOptions = snowflake.ConnectionOptions;
export interface AcquireOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ConnectionOptionsDiagnostics extends Detected {
  connectionName?: string;
  endpoint?: string;
  /** Sorted names, never values, of selected-profile keys the SDK doesn't use. */
  ignoredProfileKeys?: string[];
  providers: { id: string; state: "unprobed" | "selected" }[];
}
/** Trusted application dependency. Returned native options contain credentials. */
export interface ConnectionOptionsProvider {
  getOwnerOptions(options?: AcquireOptions): Promise<NativeConnectionOptions>;
  getCallerOptions(
    context: CallerContext,
    options?: AcquireOptions,
  ): Promise<NativeConnectionOptions>;
  /** Must be redacted and must not authenticate or acquire credentials. */
  diagnostics?(): Promise<ConnectionOptionsDiagnostics>;
}
export interface ConnectionOptionsFactory extends ConnectionOptionsProvider {
  diagnostics(): Promise<ConnectionOptionsDiagnostics>;
  /** Abort factory waits, not connections created from prior snapshots. */
  close(): Promise<void>;
}
export interface ConnectionOptionsFactoryOptions {
  connection?: ConnectionOptions;
  environment?: Environment;
  platform?: Platform;
  /** Interactive login needs local execution; "always" permits it without a terminal. */
  interactive?: "auto" | "always" | "never";
  /**
   * When caller context is missing, use owner credentials in local or preview execution
   * ("auto") or never ("error").
   */
  callerFallback?: "auto" | "error";
  /**
   * Run caller views and getCallerOptions() as the owner, even when caller context is present.
   * The SDK doesn't detect when: pass the app's own condition, such as
   * `process.env.NODE_ENV === "development"`. Default: false.
   */
  callerAsOwner?: boolean;
  authTimeoutMs?: number;
  driverOptions?: DriverOptions;
  logger?: (event: LogEvent) => void;
}

type Logger = (event: LogEvent) => void;
// Non-enumerable and immutable, but shared by mixed ESM/CJS consumers, like connection scopes.
const loggerKey = Symbol.for("@snowflake/sar-sdk/logger/v1");
const callerAsOwnerKey = Symbol.for("@snowflake/sar-sdk/caller-as-owner/v1");
const loggerOf = (provider: object): unknown => (provider as Record<symbol, unknown>)[loggerKey];
const runsCallersAsOwner = (provider: object) =>
  (provider as Record<symbol, unknown>)[callerAsOwnerKey] === true;

/** Wraps a logger to ignore its exceptions and rejections. */
function guard(logger: unknown): Logger | undefined {
  if (typeof logger !== "function") return undefined;
  return (event) => {
    try {
      void Promise.resolve((logger as Logger)(event)).catch(() => {});
    } catch {
      /* Logging cannot change an operation. */
    }
  };
}

function freezeProvider<T extends object>(
  provider: T,
  logger: unknown,
  callerAsOwner: boolean,
): Readonly<T> {
  if (typeof logger === "function") Object.defineProperty(provider, loggerKey, { value: logger });
  if (callerAsOwner) Object.defineProperty(provider, callerAsOwnerKey, { value: true });
  return Object.freeze(provider);
}

/** The logger of the factory a provider came from; custom providers have none. */
export function providerLogger(provider: ConnectionOptionsProvider): Logger | undefined {
  return guard(loggerOf(provider));
}

/** Lazy source selection; each async getter acquires fresh credentials without SQL login. */
export function createConnectionOptions(
  source?: AuthProvider | readonly AuthProvider[],
  input: ConnectionOptionsFactoryOptions = {},
): ConnectionOptionsFactory {
  keys(
    input,
    [
      "connection",
      "environment",
      "platform",
      "interactive",
      "callerFallback",
      "callerAsOwner",
      "authTimeoutMs",
      "driverOptions",
      "logger",
    ],
    "connection options",
  );
  const options = internalOptions({
    connection: input.connection,
    environment: input.environment,
    platform: input.platform,
    auth: {
      interactive: input.interactive,
      callerFallback: input.callerFallback,
      callerAsOwner: input.callerAsOwner,
      providers:
        source === undefined
          ? undefined
          : Array.isArray(source)
            ? source
            : [source as AuthProvider],
    },
    timeouts: { authMs: input.authTimeoutMs },
    driverOptions: input.driverOptions,
    logger: input.logger,
  });
  const log = guard(options.logger);
  const manager = new AuthManager({ ...options, logger: log });
  const shutdown = new AbortController();
  let closed = false;
  let fallbackReported = false;
  async function acquire(caller: string | null | undefined, settings: AcquireOptions = {}) {
    if (closed) fail("CLIENT_CLOSED", "Connection options factory is closed");
    keys(settings, ["signal", "timeoutMs"], "credential acquisition");
    signalOption(settings.signal);
    duration(settings.timeoutMs, "Credential acquisition timeout");
    const signal = AbortSignal.any([
      shutdown.signal,
      ...(settings.signal ? [settings.signal] : []),
    ]);
    checkAbort(signal);
    const resolved = await deadline(
      manager.acquire(caller),
      settings.timeoutMs ?? options.timeouts?.authMs ?? 120_000,
      signal,
      "Credentials",
    );
    checkAbort(signal);
    const native = {
      ...credentialOptions(resolved.credential, resolved.detected, options),
      ...options.driverOptions,
      ...resolved.source.target,
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
      serverSessionKeepAlive: false,
    };
    if (caller === null && !fallbackReported) {
      fallbackReported = true;
      log?.({ event: "caller-fallback", environment: resolved.detected.environment });
    }
    return native;
  }
  const factory = {
    getOwnerOptions: (settings?: AcquireOptions) => acquire(undefined, settings),
    async getCallerOptions(context: CallerContext, settings?: AcquireOptions) {
      const token = callerToken(context);
      return acquire(options.auth?.callerAsOwner ? undefined : token, settings);
    },
    async diagnostics() {
      const detected = await detect(options.environment, options.platform);
      let origin: string | undefined;
      if (
        options.connection?.accessUrl ||
        options.connection?.host ||
        options.connection?.account
      ) {
        try {
          origin = endpoint(options.connection);
        } catch {
          /* Do not echo invalid targets. */
        }
      }
      return {
        ...detected,
        connectionName:
          source === undefined
            ? selectedName(options.connection ?? {})
            : (
                manager.providers.find((provider) => provider.id === manager.selectedId) ??
                (manager.providers.length === 1 ? manager.providers[0] : undefined)
              )?.connectionName,
        endpoint: origin,
        ...(manager.ignoredProfileKeys
          ? { ignoredProfileKeys: [...manager.ignoredProfileKeys] }
          : {}),
        providers: manager.providers.map((provider) => ({
          id: provider.id,
          state: manager.selectedId === provider.id ? ("selected" as const) : ("unprobed" as const),
        })),
      };
    },
    async close() {
      closed = true;
      shutdown.abort();
    },
  };
  return freezeProvider(factory, options.logger, options.auth?.callerAsOwner === true);
}

/** Snapshot methods with receivers; structural providers are trusted code, not branded objects. */
export function snapshotProvider(provider: ConnectionOptionsProvider): ConnectionOptionsProvider {
  if (
    !provider ||
    typeof provider.getOwnerOptions !== "function" ||
    typeof provider.getCallerOptions !== "function" ||
    (provider.diagnostics !== undefined && typeof provider.diagnostics !== "function")
  )
    fail("INVALID_OPTIONS", "connectionOptions must implement owner and caller options getters");
  return freezeProvider(
    {
      getOwnerOptions: provider.getOwnerOptions.bind(provider),
      getCallerOptions: provider.getCallerOptions.bind(provider),
      diagnostics: provider.diagnostics?.bind(provider),
    },
    loggerOf(provider),
    runsCallersAsOwner(provider),
  );
}

export async function providerDiagnostics(
  provider: ConnectionOptionsProvider,
): Promise<ConnectionOptionsDiagnostics> {
  return provider.diagnostics
    ? provider.diagnostics()
    : {
        environment: "unknown",
        platform: "unknown",
        evidence: ["custom-options-provider"],
        providers: [],
      };
}

/**
 * A new immutable identity scope for each caller view, even with identical tokens. Views of a
 * callerAsOwner provider are owner scopes, but their caller context is still validated.
 */
export function optionsScope(provider: ConnectionOptionsProvider, context?: CallerContext) {
  const acquire = async (settings?: AcquireOptions) =>
    snapshotNativeOptions(await provider.getOwnerOptions(settings));
  const token = context === undefined ? undefined : callerToken(context);
  if (token === undefined || runsCallersAsOwner(provider))
    return Object.freeze({
      acquire,
      mode: "owner" as const,
      callerPresent: true,
      contextKey: undefined,
    });
  const snapshot: CallerContext = Object.freeze(
    token === null ? { headers: Object.freeze({ get: () => null }) } : { token },
  );
  return Object.freeze({
    mode: "caller" as const,
    callerPresent: token !== null,
    /** A digest of the caller token that groups views made from the same token. */
    contextKey: token === null ? undefined : createHash("sha256").update(token).digest("base64url"),
    acquire: async (settings?: AcquireOptions) =>
      snapshotNativeOptions(await provider.getCallerOptions(snapshot, settings)),
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
