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

import { readFile } from "node:fs/promises";
import type snowflake from "snowflake-sdk";
import {
  bindTarget,
  detect,
  endpoint,
  environmentFields,
  exists,
  mounts,
  profileFields,
  selectedName,
  targetFields,
  type Detected,
  type Fields,
} from "./config.js";
import { fail, isSarError, keys, nextSteps, SarError, type SarErrorCode } from "./errors.js";
import type { ConnectionOptions, Environment, HeaderReader, Platform } from "./types.js";
import type { ResolutionOptions } from "./options.js";

/** Stable identifiers used when transforming the default provider list. */
export const authProviderIds = Object.freeze({
  platform: "platform",
  environment: "environment",
  profile: "profile",
});
/** Driver-managed login recipes supported by this adapter, not arbitrary driver configuration. */
export type DriverCredentialOptions = Pick<
  snowflake.ConnectionOptions,
  | "account"
  | "accessUrl"
  | "host"
  | "username"
  | "warehouse"
  | "database"
  | "schema"
  | "role"
  | "authenticator"
  | "password"
  | "token"
  | "privateKey"
  | "privateKeyPath"
  | "privateKeyPass"
  | "oauthClientId"
  | "oauthClientSecret"
  | "oauthAuthorizationUrl"
  | "oauthTokenRequestUrl"
  | "oauthScope"
  | "oauthRedirectUri"
  | "clientStoreTemporaryCredential"
  | "clientRequestMFAToken"
  | "credentialCacheDir"
>;
/** OAuth and PAT credentials are intentionally not interchangeable. */
export type Credential =
  | { type: "oauth" | "pat"; token: string }
  | { type: "password"; username: string; password: string }
  | {
      type: "keypair";
      username: string;
      privateKey?: string;
      privateKeyPath?: string;
      privateKeyPass?: string;
    }
  | { type: "driver"; options: DriverCredentialOptions };
/** Resolution and acquisition are separate; diagnostics never call either hook. */
export interface CredentialSource {
  readonly target: ConnectionOptions;
  readonly platform?: "spcs" | "serverless";
  acquire(): Promise<Credential>;
}
/** Context is trusted application configuration, never a request-supplied target. */
export interface AuthContext {
  readonly connection: Readonly<ConnectionOptions>;
}
/** Return undefined only for an optional absent source. Other failures are fatal. */
export interface AuthProvider {
  readonly id: string;
  /** Optional configured profile name for non-probing diagnostics. */
  readonly connectionName?: string;
  resolve(context: AuthContext): Promise<CredentialSource | undefined>;
}
/** Extracts caller context; it does not validate the token or authenticate ingress. */
export function getCallerUserToken(headers: HeaderReader): string | null {
  const token = headers.get("sf-context-current-user-token");
  if (token === null || token === undefined) return null;
  if (typeof token !== "string" || !token.trim())
    fail("CALLER_CONTEXT_REQUIRED", "Present caller token cannot be empty");
  return token;
}
/** Read a trusted token file for every acquisition. Explicit paths are required by default. */
export function fromTokenFile(options: {
  id: string;
  path: string;
  type: "oauth" | "pat";
  optional?: boolean;
  target?: ConnectionOptions;
  platform?: "spcs" | "serverless";
}): AuthProvider {
  keys(options, ["id", "path", "type", "optional", "target", "platform"], "token source");
  options = { ...options, target: Object.freeze(targetFields(options.target ?? {})) };
  if (
    typeof options.id !== "string" ||
    !options.id.trim() ||
    typeof options.path !== "string" ||
    !options.path.trim() ||
    !["oauth", "pat"].includes(options.type)
  )
    fail("INVALID_OPTIONS", "Token file requires an id, path, and explicit oauth/pat type");
  if (options.optional !== undefined && typeof options.optional !== "boolean")
    fail("INVALID_OPTIONS", "Token file optional must be a boolean");
  if (
    options.platform !== undefined &&
    (options.type !== "oauth" || !["spcs", "serverless"].includes(options.platform))
  )
    fail("INVALID_OPTIONS", "Platform token files require OAuth and a recognized platform");
  return Object.freeze({
    id: options.id,
    async resolve(context: AuthContext) {
      if (!(await exists(options.path))) {
        if (options.optional) return undefined;
        fail("AUTH_NOT_FOUND", "Configured token file does not exist");
      }
      return {
        target: bindTarget(options.target ?? {}, context.connection),
        platform: options.platform,
        async acquire() {
          let token: string;
          try {
            token = (await readFile(options.path, "utf8")).trim();
          } catch (error) {
            throw new SarError("AUTH_FAILED", "Cannot read the selected token file", {}, error);
          }
          if (!token) fail("AUTH_FAILED", "Selected token file is empty or revoked");
          return { type: options.type, token };
        },
      };
    },
  });
}
/** Explicit credentials for a trusted target. Prefer rotating providers for long-lived tokens. */
export function fromCredentials(options: {
  id?: string;
  target: ConnectionOptions;
  credential: Credential;
}): AuthProvider {
  options = {
    ...options,
    target: Object.freeze(targetFields(options.target)),
    credential: credentialSnapshot(options.credential, "INVALID_OPTIONS"),
  };
  if (options.id !== undefined && (typeof options.id !== "string" || !options.id.trim()))
    fail("INVALID_OPTIONS", "Credential provider id must be a nonempty string");
  return Object.freeze({
    id: options.id ?? "explicit",
    async resolve(context: AuthContext) {
      return {
        target: bindTarget(options.target, context.connection),
        async acquire() {
          return credentialSnapshot(options.credential);
        },
      };
    },
  });
}

const driverCredentialKeys = [
  "account",
  "accessUrl",
  "host",
  "username",
  "warehouse",
  "database",
  "schema",
  "role",
  "authenticator",
  "password",
  "token",
  "privateKey",
  "privateKeyPath",
  "privateKeyPass",
  "oauthClientId",
  "oauthClientSecret",
  "oauthAuthorizationUrl",
  "oauthTokenRequestUrl",
  "oauthScope",
  "oauthRedirectUri",
  "clientStoreTemporaryCredential",
  "clientRequestMFAToken",
  "credentialCacheDir",
];

/** Validate JavaScript provider returns and detach all supported mutable inputs. */
function credentialSnapshot(input: unknown, code: SarErrorCode = "AUTH_FAILED"): Credential {
  const object = (value: unknown): Fields => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(code, "Credential must be a typed object");
    return { ...value };
  };
  const allowed = (fields: Fields, keys: readonly string[]) => {
    if (Object.keys(fields).some((key) => !keys.includes(key)))
      fail(code, "Credential contains unsupported fields");
  };
  const text = (fields: Fields, key: string, required = false) => {
    const value = fields[key];
    if (value === undefined && !required) return;
    if (typeof value !== "string" || (key !== "privateKeyPass" && !value.trim()))
      fail(code, `Credential ${key} must be a nonempty string`);
  };
  const fields = object(input);
  switch (fields.type) {
    case "oauth":
    case "pat":
      allowed(fields, ["type", "token"]);
      text(fields, "token", true);
      break;
    case "password":
      allowed(fields, ["type", "username", "password"]);
      text(fields, "username", true);
      text(fields, "password", true);
      break;
    case "keypair":
      allowed(fields, ["type", "username", "privateKey", "privateKeyPath", "privateKeyPass"]);
      text(fields, "username", true);
      for (const key of ["privateKey", "privateKeyPath", "privateKeyPass"]) text(fields, key);
      if ((fields.privateKey !== undefined) === (fields.privateKeyPath !== undefined))
        fail(code, "Key-pair credential requires exactly one private key or path");
      break;
    case "driver": {
      allowed(fields, ["type", "options"]);
      const options = object(fields.options);
      allowed(options, driverCredentialKeys);
      for (const key of Object.keys(options)) {
        if (options[key] === undefined) {
          delete options[key];
          continue;
        }
        if (["clientStoreTemporaryCredential", "clientRequestMFAToken"].includes(key)) {
          if (typeof options[key] !== "boolean") fail(code, `Credential ${key} must be a boolean`);
        } else text(options, key);
      }
      const auth = String(options.authenticator ?? "SNOWFLAKE").toUpperCase();
      if (["SNOWFLAKE", "USERNAME_PASSWORD_MFA"].includes(auth)) {
        text(options, "password", true);
      }
      if (auth === "OAUTH") text(options, "token", true);
      if (auth === "PROGRAMMATIC_ACCESS_TOKEN")
        text(options, options.token === undefined ? "password" : "token", true);
      if (
        auth === "SNOWFLAKE_JWT" &&
        (options.privateKey !== undefined) === (options.privateKeyPath !== undefined)
      )
        fail(code, "Key-pair credential requires exactly one private key or path");
      if (auth === "OAUTH_CLIENT_CREDENTIALS") {
        text(options, "oauthClientId", true);
        text(options, "oauthClientSecret", true);
      }
      const methods = [
        options.token !== undefined,
        options.password !== undefined,
        options.privateKey !== undefined || options.privateKeyPath !== undefined,
      ].filter(Boolean).length;
      if (methods > 1) fail(code, "Driver credential contains conflicting authentication methods");
      if (options.accessUrl !== undefined) options.accessUrl = endpoint(options);
      fields.options = options;
      break;
    }
    default:
      fail(code, "Provide a supported typed credential");
  }
  return fields as unknown as Credential;
}

function hasCredentials(fields: Fields): boolean {
  return !!(
    fields.token ||
    fields.tokenFilePath ||
    fields.password ||
    fields.privateKey ||
    fields.privateKeyPath ||
    fields.authenticator ||
    fields.sessionToken ||
    fields.masterToken
  );
}

function source(fields: Fields, platform?: "serverless" | "spcs"): CredentialSource {
  const target: ConnectionOptions = {};
  for (const key of ["account", "username", "warehouse", "database", "schema", "role"] as const) {
    if (fields[key]) target[key] = String(fields[key]);
  }
  target.accessUrl = endpoint(fields);
  return {
    target,
    platform,
    async acquire() {
      if (fields.sessionToken || fields.masterToken)
        fail(
          "AUTH_NOT_SUPPORTED",
          "Inherited session/master tokens cannot guarantee fresh-session isolation. Supply source credentials instead.",
        );
      if ((fields.token || fields.tokenFilePath) && !fields.authenticator)
        fail("CONFIG_INVALID", "Token credentials require an explicit OAuth or PAT authenticator");
      const methods = [
        !!(fields.token || fields.tokenFilePath),
        !!fields.password,
        !!(fields.privateKey || fields.privateKeyPath),
      ].filter(Boolean).length;
      if (methods > 1) fail("CONFIG_INVALID", "Conflicting credential fields must not be combined");
      const authenticator = String(
        fields.authenticator ??
          (fields.privateKey || fields.privateKeyPath
            ? "SNOWFLAKE_JWT"
            : fields.password
              ? "SNOWFLAKE"
              : "EXTERNALBROWSER"),
      ).toUpperCase();
      if (authenticator === "OAUTH" || authenticator === "PROGRAMMATIC_ACCESS_TOKEN") {
        if (fields.token && fields.tokenFilePath)
          fail("CONFIG_INVALID", "Choose token or tokenFilePath, not both");
        let token =
          fields.token ??
          (authenticator === "PROGRAMMATIC_ACCESS_TOKEN" ? fields.password : undefined);
        if (fields.tokenFilePath) {
          try {
            token = (await readFile(String(fields.tokenFilePath), "utf8")).trim();
          } catch (error) {
            throw new SarError("AUTH_FAILED", "Selected token file could not be read", {}, error);
          }
        }
        if (typeof token !== "string" || !token.trim())
          fail("AUTH_FAILED", "Selected credential is missing, empty, or revoked");
        return { type: authenticator === "OAUTH" ? "oauth" : "pat", token };
      }
      if (authenticator === "SNOWFLAKE" && fields.username && fields.password)
        return {
          type: "password",
          username: String(fields.username),
          password: String(fields.password),
        };
      if (authenticator === "SNOWFLAKE_JWT" && fields.username) {
        if (!fields.privateKey && !fields.privateKeyPath)
          fail("CONFIG_INVALID", "Key-pair authentication requires a private key or path");
        return {
          type: "keypair",
          username: String(fields.username),
          privateKey: fields.privateKey as string | undefined,
          privateKeyPath: fields.privateKeyPath as string | undefined,
          privateKeyPass: fields.privateKeyPass as string | undefined,
        };
      }
      if (
        ![
          "EXTERNALBROWSER",
          "USERNAME_PASSWORD_MFA",
          "OAUTH_AUTHORIZATION_CODE",
          "OAUTH_CLIENT_CREDENTIALS",
        ].includes(authenticator)
      )
        fail(
          "AUTH_NOT_SUPPORTED",
          "This authenticator is not supported by the initial SAR adapter; supply a typed custom provider",
        );
      const { protocol: _protocol, port: _port, ...options } = fields;
      return {
        type: "driver",
        options: { ...options, ...target, authenticator } as snowflake.ConnectionOptions,
      };
    },
  };
}

/** Names of profile keys the SDK skipped, kept off the public source type. */
const ignoredKeys = new WeakMap<CredentialSource, readonly string[]>();

/** A SnowCLI-compatible profile source. Selection does not imply local execution. */
export function fromToml(
  input: {
    name?: string;
    configFile?: string;
    environmentOverrides?: boolean;
  } = {},
): AuthProvider {
  keys(input, ["name", "configFile", "environmentOverrides"], "TOML source");
  const selectors = Object.freeze(
    targetFields({ name: input.name, configFile: input.configFile }, true),
  );
  const overlays = input.environmentOverrides === undefined ? true : input.environmentOverrides;
  if (typeof overlays !== "boolean")
    fail("INVALID_OPTIONS", "environmentOverrides must be a boolean");
  return Object.freeze({
    id: authProviderIds.profile,
    connectionName: selectors.name,
    async resolve(context: AuthContext) {
      for (const key of ["name", "configFile"] as const)
        if (
          selectors[key] !== undefined &&
          context.connection[key] !== undefined &&
          selectors[key] !== context.connection[key]
        )
          fail("CONFIG_INVALID", "Conflicting profile selectors");
      const ignored: string[] = [];
      const fields = await profileFields(
        { ...context.connection, ...selectors },
        overlays,
        ignored,
      );
      if (!fields) return undefined;
      const found = source(fields);
      if (ignored.length) ignoredKeys.set(found, [...new Set(ignored)].sort());
      return found;
    },
  });
}

/** A complete environment identity; returns undefined only when absent/incomplete. */
export function fromEnvironment(): AuthProvider {
  return Object.freeze({
    id: authProviderIds.environment,
    async resolve(context: AuthContext) {
      const fields = bindTarget(environmentFields(), context.connection);
      if (!(fields.account || fields.host || fields.accessUrl) || !hasCredentials(fields))
        return undefined;
      return source(fields);
    },
  });
}

/** Verified application mounts only; never host-agent credentials. */
export function fromPlatform(
  input: { environment?: Environment; platform?: Platform } = {},
): AuthProvider {
  keys(input, ["environment", "platform"], "platform source");
  const { environment, platform } = input;
  if (environment !== undefined && !["auto", "local", "preview", "deployed"].includes(environment))
    fail("INVALID_OPTIONS", "Invalid environment");
  if (platform !== undefined && !["auto", "spcs", "serverless"].includes(platform))
    fail("INVALID_OPTIONS", "Invalid platform");
  return Object.freeze({
    id: authProviderIds.platform,
    async resolve(context: AuthContext) {
      const detected = await detect(environment, platform);
      const filename =
        detected.platform === "serverless" && (await exists(mounts.serverless))
          ? mounts.serverless
          : mounts.spcs;
      if (!(await exists(filename))) return undefined;
      const fields = bindTarget(environmentFields(), context.connection);
      return source(
        {
          ...fields,
          authenticator: "OAUTH",
          token: undefined,
          password: undefined,
          tokenFilePath: filename,
        },
        detected.platform === "serverless" ? "serverless" : "spcs",
      );
    },
  });
}

export function defaultProviders(options: ResolutionOptions): readonly AuthProvider[] {
  options = {
    ...options,
    connection: Object.freeze(targetFields(options.connection ?? {}, true)),
    auth: { ...options.auth },
  };
  const connection = options.connection!;
  const profileSource = fromToml({
    environmentOverrides: options.auth?.profileEnvironmentOverrides,
  });
  const profile: AuthProvider = {
    id: profileSource.id,
    resolve: () => profileSource.resolve({ connection }),
  };
  if (selectedName(connection) || connection.configFile)
    return Object.freeze([Object.freeze(profile)]);
  return Object.freeze([
    fromPlatform({ environment: options.environment, platform: options.platform }),
    fromEnvironment(),
    Object.freeze(profile),
  ]);
}

function providerError(error: unknown, phase: "resolution" | "acquisition"): SarError {
  const codes: readonly SarErrorCode[] = [
    "CONFIG_NOT_FOUND",
    "CONFIG_INVALID",
    "AUTH_NOT_FOUND",
    "AUTH_FAILED",
    "AUTH_NOT_SUPPORTED",
    "AUTH_INTERACTION_REQUIRED",
  ];
  const code = isSarError(error) && codes.includes(error.code) ? error.code : "AUTH_FAILED";
  // Provider-supplied hints are untrusted; only the SDK's own are kept.
  const nextStep = isSarError(error) ? error.details?.nextStep : undefined;
  return new SarError(
    code,
    `Authentication provider ${phase} failed; the source was not changed`,
    nextStep && Object.values<string>(nextSteps).includes(nextStep) ? { nextStep } : {},
    error,
  );
}

/** Where missing caller context may use owner credentials, by callerFallback policy. */
const callerFallbacks: Record<
  "auto" | "error",
  { environments: readonly Detected["environment"][]; refusal: string }
> = {
  auto: {
    environments: ["local", "preview"],
    refusal: "Caller context is required outside recognized local/preview execution",
  },
  error: {
    environments: [],
    refusal: 'Caller context is required because callerFallback is "error"',
  },
};

export class AuthManager {
  readonly providers: readonly AuthProvider[];
  private selection?: Promise<CredentialSource>;
  selectedId?: string;
  ignoredProfileKeys?: readonly string[];
  constructor(readonly options: ResolutionOptions) {
    this.options = Object.freeze({
      ...options,
      connection: Object.freeze(targetFields(options.connection ?? {}, true)),
      auth: Object.freeze({ ...options.auth }),
    });
    const defaults = defaultProviders(this.options);
    const requested = this.options.auth?.providers;
    const registrations =
      typeof requested === "function" ? requested(defaults) : (requested ?? defaults);
    if (!Array.isArray(registrations))
      fail("INVALID_OPTIONS", "Authentication providers must be an array");
    const ids = new Set<string>();
    this.providers = Object.freeze(
      Array.from(registrations, (provider: AuthProvider) => {
        if (!provider || typeof provider !== "object")
          fail("INVALID_OPTIONS", "Authentication provider must be an object");
        const { id, resolve, connectionName } = provider;
        if (typeof id !== "string" || !id.trim() || typeof resolve !== "function" || ids.has(id))
          fail("INVALID_OPTIONS", "Authentication providers need unique IDs and resolve functions");
        if (
          connectionName !== undefined &&
          (typeof connectionName !== "string" || !connectionName.trim())
        )
          fail("INVALID_OPTIONS", "Configured profile name must be a nonempty string");
        ids.add(id);
        return Object.freeze({ id, connectionName, resolve: resolve.bind(provider) });
      }),
    );
  }
  async source(): Promise<CredentialSource> {
    this.selection ??= (async () => {
      for (const provider of this.providers) {
        let found: CredentialSource | undefined;
        try {
          found = await provider.resolve({
            connection: Object.freeze({ ...this.options.connection }),
          });
        } catch (error) {
          throw providerError(error, "resolution");
        }
        if (found !== undefined) {
          if (!found || typeof found !== "object" || Array.isArray(found))
            fail("AUTH_FAILED", "Provider must return a credential source or undefined");
          const { acquire, platform } = found;
          if (
            typeof acquire !== "function" ||
            (platform !== undefined && !["serverless", "spcs"].includes(platform))
          )
            fail("AUTH_FAILED", "Provider returned an invalid credential source");
          const target = targetFields(
            bindTarget(targetFields(found.target), this.options.connection ?? {}),
          );
          target.accessUrl = endpoint(target);
          this.selectedId = provider.id;
          this.ignoredProfileKeys = ignoredKeys.get(found);
          if (this.ignoredProfileKeys) {
            try {
              this.options.logger?.({
                event: "profile-keys-ignored",
                keys: [...this.ignoredProfileKeys],
              });
            } catch {
              /* Logging cannot change authentication. */
            }
          }
          return Object.freeze({
            target: Object.freeze(target),
            platform,
            acquire: async () => {
              let credential: Credential;
              try {
                credential = await acquire.call(found);
              } catch (error) {
                throw providerError(error, "acquisition");
              }
              return credentialSnapshot(credential);
            },
          });
        }
      }
      throw new SarError(
        "AUTH_NOT_FOUND",
        "No Snowflake credentials found. Configure a SnowCLI profile or a typed authentication provider.",
        this.providers.some((provider) => provider.id === authProviderIds.profile)
          ? { nextStep: nextSteps.discovery }
          : {},
      );
    })();
    return this.selection;
  }
  async acquire(
    caller: string | null | undefined,
  ): Promise<{ source: CredentialSource; credential: Credential; detected: Detected }> {
    if (caller !== null && caller !== undefined && (typeof caller !== "string" || !caller.trim()))
      fail("CALLER_CONTEXT_REQUIRED", "Present caller token cannot be empty");
    const detected = await detect(this.options.environment, this.options.platform);
    const policy = this.options.auth?.callerFallback ?? "auto";
    if (caller === null && !callerFallbacks[policy].environments.includes(detected.environment))
      throw new SarError("CALLER_CONTEXT_REQUIRED", callerFallbacks[policy].refusal, {
        nextStep:
          policy === "auto" && detected.environment === "unknown"
            ? nextSteps.callerFallback
            : nextSteps.ingress,
      });
    const selected = await this.source();
    if (
      selected.platform &&
      detected.platform !== "unknown" &&
      selected.platform !== detected.platform
    )
      fail(
        "ENVIRONMENT_CONFLICT",
        "Credential source platform conflicts with environment evidence",
      );
    const credential = await selected.acquire();
    if (selected.platform && credential.type !== "oauth")
      fail("AUTH_NOT_SUPPORTED", "Platform credential sources require OAuth");
    const identity =
      credential.type === "password" || credential.type === "keypair"
        ? { username: credential.username }
        : credential.type === "driver"
          ? credential.options
          : {};
    const bound = bindTarget(identity, selected.target);
    if (
      credential.type === "driver" &&
      ["SNOWFLAKE", "SNOWFLAKE_JWT", "USERNAME_PASSWORD_MFA"].includes(
        (credential.options.authenticator ?? "SNOWFLAKE").toUpperCase(),
      ) &&
      !bound.username
    )
      fail("AUTH_FAILED", "Driver credential requires a username on the credential or its target");
    if (caller === undefined || caller === null) return { source: selected, credential, detected };
    const platform =
      selected.platform ??
      (this.options.platform && this.options.platform !== "auto"
        ? this.options.platform
        : "unknown");
    if (credential.type !== "oauth" || platform === "unknown")
      fail(
        "AUTH_NOT_SUPPORTED",
        "Caller authentication requires a recognized OAuth platform source",
      );
    return {
      source: selected,
      detected,
      credential: {
        type: "oauth",
        token: platform === "spcs" ? `${credential.token}.${caller}` : caller,
      },
    };
  }
}

export function credentialOptions(
  credential: Credential,
  detected: Detected,
  options: ResolutionOptions,
): snowflake.ConnectionOptions {
  credential = credentialSnapshot(credential);
  switch (credential.type) {
    case "oauth":
      return { authenticator: "OAUTH", token: credential.token };
    case "pat":
      return { authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token: credential.token };
    case "password":
      return {
        username: credential.username,
        password: credential.password,
        authenticator: "SNOWFLAKE",
      };
    case "keypair":
      return {
        username: credential.username,
        privateKey: credential.privateKey,
        privateKeyPath: credential.privateKeyPath,
        privateKeyPass: credential.privateKeyPass,
        authenticator: "SNOWFLAKE_JWT",
      };
    case "driver": {
      const auth = credential.options.authenticator?.toUpperCase();
      const interactive = [
        "EXTERNALBROWSER",
        "USERNAME_PASSWORD_MFA",
        "OAUTH_AUTHORIZATION_CODE",
      ].includes(auth ?? "");
      const policy = options.auth?.interactive ?? "auto";
      const local = detected.environment === "local" && !process.env.CI;
      if (
        interactive &&
        (!local ||
          policy === "never" ||
          (policy === "auto" && !(process.stdin.isTTY && process.stdout.isTTY)))
      )
        throw new SarError(
          "AUTH_INTERACTION_REQUIRED",
          "Interactive login needs a local terminal or explicit local interactive integration",
          { nextStep: local ? nextSteps.interaction : nextSteps.nonInteractive },
        );
      return credential.options;
    }
  }
}
