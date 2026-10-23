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

import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { fail, nextSteps, SarError } from "./errors.js";
import type { ConnectionOptions, Environment, Platform } from "./types.js";

export const mounts = {
  serverless: "/snowflake/secrets/snowflake-session/token",
  spcs: "/snowflake/session/token",
};
export type Fields = Record<string, unknown>;
const aliases: Record<string, string> = {
  user: "username",
  login_name: "username",
  account_url: "accessUrl",
  token_file_path: "tokenFilePath",
  private_key_path: "privateKeyPath",
  private_key_file: "privateKeyPath",
  private_key: "privateKey",
  private_key_file_pwd: "privateKeyPass",
  private_key_pass: "privateKeyPass",
  session_token: "sessionToken",
  master_token: "masterToken",
  oauth_client_id: "oauthClientId",
  oauth_client_secret: "oauthClientSecret",
  oauth_token_request_url: "oauthTokenRequestUrl",
  oauth_scope: "oauthScope",
  oauth_authorization_url: "oauthAuthorizationUrl",
  oauth_redirect_uri: "oauthRedirectUri",
  client_store_temporary_credential: "clientStoreTemporaryCredential",
  client_request_mfa_token: "clientRequestMFAToken",
  credential_cache_dir: "credentialCacheDir",
};
const direct = [
  "account",
  "username",
  "password",
  "host",
  "port",
  "protocol",
  "warehouse",
  "database",
  "schema",
  "role",
  "authenticator",
  "token",
  "region",
];
const credentialFields = [
  "password",
  "token",
  "tokenFilePath",
  "privateKey",
  "privateKeyPath",
  "privateKeyPass",
  "sessionToken",
  "masterToken",
  "oauthClientId",
  "oauthClientSecret",
  "oauthTokenRequestUrl",
  "oauthAuthorizationUrl",
  "oauthScope",
  "oauthRedirectUri",
];
const targetKeys = [
  "account",
  "host",
  "accessUrl",
  "username",
  "warehouse",
  "database",
  "schema",
  "role",
];

/** Copy only target fields; provider targets must never carry driver/auth options. */
export function targetFields(input: unknown, selectors = false): ConnectionOptions {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("CONFIG_INVALID", "Connection target must be an object");
  const target: Fields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!targetKeys.includes(key) && !(selectors && ["name", "configFile"].includes(key)))
      fail("CONFIG_INVALID", `Unsupported connection target field: ${key}`);
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim())
      fail("CONFIG_INVALID", `Connection target ${key} must be a nonempty string`);
    target[key] = value;
  }
  return target;
}

function rejectRegion(fields: Fields): void {
  if (fields.region !== undefined)
    fail(
      "CONFIG_INVALID",
      "The region option is not supported; use a region-qualified account identifier or explicit HTTPS host/accessUrl",
    );
}

export async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new SarError("CONFIG_INVALID", "Cannot access configured file", {}, error);
  }
}

/** Profiles are shared with other tools: collect keys the SDK doesn't use instead of failing. */
export function normalize(input: Fields, ignored: string[] = []): Fields {
  rejectRegion(input);
  const output: Fields = {};
  for (const [key, value] of Object.entries(input)) {
    const mapped = Object.hasOwn(aliases, key)
      ? aliases[key]
      : direct.includes(key) || Object.values(aliases).includes(key) || key === "accessUrl"
        ? key
        : undefined;
    if (!mapped) {
      ignored.push(key);
      continue;
    }
    if (mapped === "clientStoreTemporaryCredential" || mapped === "clientRequestMFAToken") {
      if (value !== true && value !== false && value !== "true" && value !== "false")
        fail("CONFIG_INVALID", `${key} must be a boolean`);
      output[mapped] = value === true || value === "true";
    } else {
      if (typeof value !== "string" && typeof value !== "number")
        fail("CONFIG_INVALID", `${key} must be a string or number`);
      output[mapped] = value;
    }
  }
  return output;
}

export function environmentFields(prefix = "SNOWFLAKE_"): Fields {
  const fields: Fields = {};
  for (const key of [...direct, ...Object.keys(aliases)]) {
    const value = process.env[`${prefix}${key.toUpperCase()}`];
    if (value !== undefined && value !== "") fields[key] = value;
  }
  return normalize(fields);
}

export function mergeFields(base: Fields, overlay: Fields, genericDefaults = false): Fields {
  const boundIdentity =
    credentialFields.some((key) => base[key] !== undefined) || base.authenticator !== undefined;
  const merged = { ...base };
  const sameAccount =
    typeof base.account === "string" &&
    typeof overlay.account === "string" &&
    base.account.toLowerCase() === overlay.account.toLowerCase();
  const inheritsEndpoint =
    sameAccount && overlay.host === undefined && overlay.accessUrl === undefined;
  // Replace an unbound generic target as a unit, not an old host/port paired
  // with the selected profile's different account or endpoint. Preserve private
  // endpoint defaults when the profile explicitly selects that same account.
  if (
    genericDefaults &&
    !boundIdentity &&
    !inheritsEndpoint &&
    ["account", "host", "accessUrl"].some((key) => overlay[key] !== undefined)
  ) {
    for (const key of ["account", "host", "accessUrl", "port", "protocol"]) delete merged[key];
  }
  compatibleTargets(merged, overlay, boundIdentity);
  if (
    overlay.authenticator !== undefined &&
    String(overlay.authenticator).toUpperCase() !==
      String(base.authenticator ?? "SNOWFLAKE").toUpperCase()
  ) {
    for (const key of credentialFields) delete merged[key];
  }
  return { ...merged, ...overlay };
}

export function selectedName(connection: ConnectionOptions): string | undefined {
  return (
    connection.name ??
    process.env.SNOWFLAKE_CONNECTION_NAME ??
    process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME
  );
}

async function configDirectory(): Promise<string> {
  if (process.env.SNOWFLAKE_HOME) return path.resolve(process.env.SNOWFLAKE_HOME);
  const home = os.homedir();
  const legacy = path.join(home, ".snowflake");
  if (await exists(legacy)) return legacy;
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "snowflake");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "snowflake");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "snowflake");
}

async function readConfig(filename: string, required = false): Promise<Fields | undefined> {
  if (!(await exists(filename))) {
    if (required)
      throw new SarError("CONFIG_NOT_FOUND", "Explicit configuration file does not exist", {
        nextStep: nextSteps.configFile,
      });
    return undefined;
  }
  try {
    const info = await stat(filename);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      fail(
        "CONFIG_INVALID",
        "Snowflake configuration must not be accessible by other users; set file permissions to 0600",
      );
    }
    return parse((await readFile(filename, "utf8")).replace(/^\uFEFF/, "")) as Fields;
  } catch (error) {
    if (error instanceof SarError) throw error;
    throw new SarError("CONFIG_INVALID", "Cannot read or parse Snowflake configuration", {}, error);
  }
}

function profiles(document: Fields, nestedOnly: boolean): Fields {
  if (
    document.connections &&
    typeof document.connections === "object" &&
    !Array.isArray(document.connections)
  )
    return document.connections as Fields;
  if (nestedOnly) return {};
  return Object.fromEntries(
    Object.entries(document).filter(
      ([key, value]) =>
        key !== "default_connection_name" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value),
    ),
  );
}

export async function profileFields(
  connection: ConnectionOptions,
  overlays = true,
  ignored: string[] = [],
): Promise<Fields | undefined> {
  connection = targetFields(connection, true);
  const directory = await configDirectory();
  const explicit = connection.configFile;
  const config = await readConfig(explicit ?? path.join(directory, "config.toml"), !!explicit);
  const connections = explicit
    ? undefined
    : await readConfig(path.join(directory, "connections.toml"));
  const name =
    selectedName(connection) ??
    String(config?.default_connection_name ?? connections?.default_connection_name ?? "default");
  const collection = connections ? profiles(connections, false) : profiles(config ?? {}, !explicit);
  const profile = collection[name];
  const named = overlays ? environmentFields(`SNOWFLAKE_CONNECTIONS_${name.toUpperCase()}_`) : {};
  if (!profile && !Object.keys(named).length) {
    if (selectedName(connection) || explicit || config || connections)
      throw new SarError("CONFIG_NOT_FOUND", `Selected connection '${name}' was not found`, {
        nextStep: nextSteps.discovery,
      });
    return undefined;
  }
  if (
    profile !== undefined &&
    (typeof profile !== "object" || profile === null || Array.isArray(profile))
  )
    fail("CONFIG_INVALID", "Selected connection must be a table");
  const generic = overlays ? environmentFields() : {};
  let fields = mergeFields(generic, normalize((profile ?? {}) as Fields, ignored), true);
  fields = mergeFields(fields, named);
  fields = bindTarget(fields, connection);
  const base = explicit ? path.dirname(path.resolve(explicit)) : directory;
  for (const key of ["tokenFilePath", "privateKeyPath", "credentialCacheDir"]) {
    if (typeof fields[key] === "string") {
      const filename = fields[key] as string;
      fields[key] = filename.startsWith("~/")
        ? path.join(os.homedir(), filename.slice(2))
        : path.resolve(base, filename);
    }
  }
  return fields;
}

export function bindTarget(
  fields: Fields | ConnectionOptions,
  connection: ConnectionOptions,
): Fields {
  const { name: _name, configFile: _file, ...target } = targetFields(connection, true);
  compatibleTargets({ ...fields }, target, true);
  return { ...fields, ...target };
}

function compatibleTargets(base: Fields, overlay: Fields, matchUsername: boolean): void {
  rejectRegion(base);
  rejectRegion(overlay);
  for (const key of matchUsername ? ["account", "username"] : ["account"]) {
    if (
      base[key] !== undefined &&
      overlay[key] !== undefined &&
      String(base[key]).toLowerCase() !== String(overlay[key]).toLowerCase()
    ) {
      fail(
        "CONFIG_INVALID",
        `Connection ${key} conflicts across configuration sources. Select a matching source instead.`,
      );
    }
  }
  const baseExplicit = base.host !== undefined || base.accessUrl !== undefined;
  const overlayExplicit = overlay.host !== undefined || overlay.accessUrl !== undefined;
  const baseOrigin = baseExplicit || base.account !== undefined ? endpoint(base) : undefined;
  const overlayOrigin =
    overlayExplicit || overlay.account !== undefined ? endpoint(overlay) : undefined;
  const mergedOrigin = baseOrigin || overlayOrigin ? endpoint({ ...base, ...overlay }) : undefined;
  const sameAccount =
    base.account !== undefined &&
    overlay.account !== undefined &&
    String(base.account).toLowerCase() === String(overlay.account).toLowerCase();
  // A same-account overlay can supply a custom endpoint, but cannot replace an
  // already explicit endpoint. Without that identity anchor, origins must agree.
  if (
    baseOrigin &&
    overlayOrigin &&
    baseOrigin !== overlayOrigin &&
    ((baseExplicit && overlayExplicit) || !sameAccount)
  ) {
    fail(
      "CONFIG_INVALID",
      "Connection endpoints conflict across configuration sources; configure the account and its custom endpoint together",
    );
  }
  if (baseExplicit && mergedOrigin !== baseOrigin)
    fail(
      "CONFIG_INVALID",
      "An explicit credential source endpoint cannot be changed by an overlay",
    );
}

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string")
    fail(
      "CONFIG_INVALID",
      "Provide a valid Snowflake account identifier or explicit HTTPS host/accessUrl",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("CONFIG_INVALID", "Invalid Snowflake endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail(
      "CONFIG_INVALID",
      "Snowflake endpoint must be an HTTPS origin without credentials, path, or query",
    );
  return url.origin;
}

export function endpoint(input: Fields | ConnectionOptions): string {
  const fields: Fields = { ...input };
  rejectRegion(fields);
  if (fields.protocol !== undefined && fields.protocol !== "https")
    fail("CONFIG_INVALID", "Snowflake endpoint protocol must be https");
  if (
    fields.port !== undefined &&
    (!/^\d+$/.test(String(fields.port)) || Number(fields.port) < 1 || Number(fields.port) > 65535)
  )
    fail("CONFIG_INVALID", "Snowflake endpoint port must be between 1 and 65535");
  const accessOrigin = fields.accessUrl !== undefined ? httpsOrigin(fields.accessUrl) : undefined;
  if (
    accessOrigin &&
    fields.port !== undefined &&
    Number(new URL(accessOrigin).port || 443) !== Number(fields.port)
  )
    fail("CONFIG_INVALID", "Snowflake port and accessUrl must identify the same HTTPS origin");
  let hostOrigin: string | undefined;
  if (fields.host !== undefined) {
    if (typeof fields.host !== "string" || !fields.host || /[\s/@?#\\]/.test(fields.host))
      fail("CONFIG_INVALID", "Snowflake host must be a hostname, optionally with a port");
    hostOrigin = httpsOrigin(
      `https://${fields.host}${fields.port !== undefined ? `:${fields.port}` : ""}`,
    );
  }
  if (accessOrigin && hostOrigin && accessOrigin !== hostOrigin) {
    const hostHasPort = fields.port !== undefined || /:\d+$/.test(String(fields.host));
    if (new URL(accessOrigin).hostname !== new URL(hostOrigin).hostname || hostHasPort)
      fail("CONFIG_INVALID", "Snowflake host and accessUrl must identify the same HTTPS origin");
  }
  if (accessOrigin || hostOrigin) return (accessOrigin ?? hostOrigin)!;
  if (
    typeof fields.account === "string" &&
    /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(fields.account)
  )
    return httpsOrigin(
      `https://${fields.account}.snowflakecomputing.com${fields.port !== undefined ? `:${fields.port}` : ""}`,
    );
  return fail(
    "CONFIG_INVALID",
    "Provide a valid Snowflake account identifier or explicit HTTPS host/accessUrl",
  );
}

export interface Detected {
  environment: "local" | "preview" | "deployed" | "unknown";
  platform: "serverless" | "spcs" | "unknown";
  evidence: string[];
}
export async function detect(
  environment: Environment = "auto",
  platform: Platform = "auto",
): Promise<Detected> {
  const serverless = await exists(mounts.serverless);
  const spcs = await exists(mounts.spcs);
  const preview = !!process.env.SNOWFLAKE_PREVIEW_ORIGIN;
  const evidence = [
    serverless ? "serverless-mount" : "",
    spcs ? "service-mount" : "",
    preview ? "preview-origin" : "",
  ].filter(Boolean);
  const detectedPlatform = serverless || preview ? "serverless" : spcs ? "spcs" : "unknown";
  if (platform !== "auto" && detectedPlatform !== "unknown" && platform !== detectedPlatform)
    fail("ENVIRONMENT_CONFLICT", "Explicit platform conflicts with platform evidence");
  let mode: Detected["environment"] = preview
    ? "preview"
    : serverless || spcs
      ? "deployed"
      : "unknown";
  if (mode === "unknown" && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
    mode = "local";
    evidence.push("interactive-terminal");
  }
  if (
    mode === "unknown" &&
    process.env.NODE_ENV === "development" &&
    process.env.npm_lifecycle_event === "dev" &&
    !process.env.CI
  ) {
    mode = "local";
    evidence.push("npm-dev-launch");
  }
  if (environment !== "auto") {
    if ((serverless || spcs || preview) && environment !== mode)
      fail("ENVIRONMENT_CONFLICT", "Explicit environment conflicts with platform evidence");
    mode = environment;
    evidence.push("explicit-environment");
  }
  return {
    environment: mode,
    platform: platform === "auto" ? detectedPlatform : platform,
    evidence,
  };
}
