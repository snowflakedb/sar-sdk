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

import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { fail, nextSteps, SarError } from "../core/errors.js";

/** Where SPCS and Serverless both mount the service's OAuth session token. */
export const platformTokenFile = "/snowflake/session/token";
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

function rejectRegion(fields: Fields): void {
  if (fields.region !== undefined)
    fail(
      "CONFIG_INVALID",
      "The region option is not supported; use a region-qualified account identifier or explicit HTTPS host/accessUrl",
    );
}

export function exists(filename: string): boolean {
  try {
    return existsSync(filename);
  } catch (error) {
    throw new SarError("CONFIG_INVALID", "Cannot access configured file", {}, error);
  }
}

/** Profiles are shared with other tools: keys the SDK doesn't use are dropped, not rejected. */
export function normalize(input: Fields): Fields {
  rejectRegion(input);
  const output: Fields = {};
  for (const [key, value] of Object.entries(input)) {
    const mapped = Object.hasOwn(aliases, key)
      ? aliases[key]
      : direct.includes(key) || Object.values(aliases).includes(key) || key === "accessUrl"
        ? key
        : undefined;
    if (!mapped) continue;
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

/** The SNOWFLAKE_* values a platform sets for its own service; not a user configuration source. */
export function environmentFields(prefix = "SNOWFLAKE_"): Fields {
  const fields: Fields = {};
  for (const key of [...direct, ...Object.keys(aliases)]) {
    const value = process.env[`${prefix}${key.toUpperCase()}`];
    if (value !== undefined && value !== "") fields[key] = value;
  }
  return normalize(fields);
}

function configDirectory(): string {
  if (process.env.SNOWFLAKE_HOME) return path.resolve(process.env.SNOWFLAKE_HOME);
  const home = os.homedir();
  const legacy = path.join(home, ".snowflake");
  if (exists(legacy)) return legacy;
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "snowflake");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "snowflake");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "snowflake");
}

function readConfig(filename: string, required = false): Fields | undefined {
  if (!exists(filename)) {
    if (required)
      throw new SarError("CONFIG_NOT_FOUND", "Explicit configuration file does not exist", {
        nextStep: nextSteps.configFile,
      });
    return undefined;
  }
  try {
    const info = statSync(filename);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      fail(
        "CONFIG_INVALID",
        "Snowflake configuration must not be accessible by other users; set file permissions to 0600",
      );
    }
    return parse(readFileSync(filename, "utf8").replace(/^﻿/, "")) as Fields;
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

/** The selected profile's fields, with file paths resolved against the file that names them. */
export function profileFields(selectors: { name?: string; configFile?: string }): Fields {
  const directory = configDirectory();
  const explicit = selectors.configFile;
  const config = readConfig(explicit ?? path.join(directory, "config.toml"), !!explicit);
  const connections = explicit ? undefined : readConfig(path.join(directory, "connections.toml"));
  const name =
    selectors.name ??
    String(config?.default_connection_name ?? connections?.default_connection_name ?? "default");
  const collection = connections ? profiles(connections, false) : profiles(config ?? {}, !explicit);
  const profile = collection[name];
  if (!profile)
    throw new SarError("CONFIG_NOT_FOUND", `Selected connection '${name}' was not found`, {
      nextStep: nextSteps.discovery,
    });
  if (typeof profile !== "object" || profile === null || Array.isArray(profile))
    fail("CONFIG_INVALID", "Selected connection must be a table");
  const fields = normalize(profile as Fields);
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

export function endpoint(input: object): string {
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
