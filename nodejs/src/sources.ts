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

import { readFileSync } from "node:fs";
import type snowflake from "snowflake-sdk";
import {
  endpoint,
  environmentFields,
  exists,
  platformTokenFile,
  profileFields,
  type Fields,
} from "./config.js";
import { fail, keys, SarError } from "./errors.js";

/** Reads the token file whenever the options are read, so a rotated token is picked up. */
function withTokenFile(options: snowflake.ConnectionOptions, filename: string) {
  return Object.defineProperty(options, "token", {
    enumerable: true,
    get(): string {
      let token: string;
      try {
        token = readFileSync(filename, "utf8").trim();
      } catch (error) {
        throw new SarError("AUTH_FAILED", "Cannot read the selected token file", {}, error);
      }
      if (!token) fail("AUTH_FAILED", "Selected token file is empty or revoked");
      return token;
    },
  });
}

const contextKeys = ["account", "username", "warehouse", "database", "schema", "role"];

/** Read one SnowCLI connection from its TOML configuration, without environment overlays. */
export function fromToml(
  input: {
    name?: string;
    configFile?: string;
  } = {},
): snowflake.ConnectionOptions {
  keys(input, ["name", "configFile"], "TOML source");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      fail("INVALID_OPTIONS", `${key} must be a nonempty string`);
  const { host, port, protocol, tokenFilePath, ...fields } = profileFields(input);
  const options: Fields = { ...fields, accessUrl: endpoint({ ...fields, host, port, protocol }) };
  for (const [key, value] of Object.entries(options))
    if (typeof value === "number") options[key] = String(value);
  if ((options.token || tokenFilePath) && !options.authenticator)
    fail("CONFIG_INVALID", "Token credentials require an explicit OAuth or PAT authenticator");
  if (options.token && tokenFilePath)
    fail("CONFIG_INVALID", "Choose token or tokenFilePath, not both");
  const result = options as snowflake.ConnectionOptions;
  return tokenFilePath ? withTokenFile(result, String(tokenFilePath)) : result;
}

/**
 * The OAuth session token a Snowflake-hosted service mounts at /snowflake/session/token, with the
 * account and endpoint it sets in SNOWFLAKE_* variables. The same on SPCS and Serverless. Returned
 * options hold the owner's token, so caller options append the caller's token to it.
 */
export function fromPlatform(): snowflake.ConnectionOptions;
export function fromPlatform(...input: unknown[]): snowflake.ConnectionOptions {
  if (input.some((value) => value !== undefined))
    fail("INVALID_OPTIONS", "fromPlatform takes no options");
  // Check the token first: outside the platform, a missing token is the clearer error.
  if (!exists(platformTokenFile))
    fail("AUTH_NOT_FOUND", "The platform session token file does not exist");
  const fields = environmentFields();
  const options: Fields = { accessUrl: endpoint(fields), authenticator: "OAUTH" };
  for (const key of contextKeys) if (fields[key]) options[key] = String(fields[key]);
  return withTokenFile(options as snowflake.ConnectionOptions, platformTokenFile);
}

/**
 * The platform's session token when the service has mounted one, otherwise the default SnowCLI
 * profile, so an app needs no NODE_ENV check to run both deployed and locally. It takes no
 * options: to choose a profile or a source yourself, call fromToml() or fromPlatform() directly.
 */
export function fromDefault(): snowflake.ConnectionOptions;
export function fromDefault(...input: unknown[]): snowflake.ConnectionOptions {
  if (input.some((value) => value !== undefined))
    fail("INVALID_OPTIONS", "fromDefault takes no options");
  return exists(platformTokenFile) ? fromPlatform() : fromToml();
}
