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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fromToml } from "../src/auth.js";
import { profileFields } from "../src/config.js";
import { nextSteps } from "../src/errors.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-test-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const file = (name: string, contents: string) =>
  writeFile(path.join(directory, name), contents, { mode: 0o600 });

describe("configuration discovery", () => {
  it("ignores generic SNOWFLAKE_* endpoint variables for a profile", async () => {
    await file(
      "connections.toml",
      '[dev]\naccount="same-account"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "same-account");
    vi.stubEnv("SNOWFLAKE_HOST", "private.invalid");
    vi.stubEnv("SNOWFLAKE_PORT", "8443");
    expect(profileFields({ name: "dev" })).toEqual({
      account: "same-account",
      authenticator: "oauth",
      token: "synthetic",
    });
    expect(fromToml({ name: "dev" }).accessUrl).toBe("https://same-account.snowflakecomputing.com");
  });
  it("keeps the profile's account when SNOWFLAKE_* variables name another", async () => {
    await file(
      "connections.toml",
      '[dev]\naccount="selected-account"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_HOST", "generic.invalid");
    vi.stubEnv("SNOWFLAKE_PORT", "8443");
    const options = fromToml({ name: "dev" });
    expect(options).toMatchObject({ account: "selected-account", token: "synthetic" });
    expect(options.accessUrl).toBe("https://selected-account.snowflakecomputing.com");
    expect(options).not.toHaveProperty("host");
    expect(options).not.toHaveProperty("port");
  });
  it("does not take credentials from SNOWFLAKE_* variables", async () => {
    await file("connections.toml", '[dev]\naccount="selected-account"');
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
    vi.stubEnv("SNOWFLAKE_TOKEN", "synthetic");
    vi.stubEnv("SNOWFLAKE_PASSWORD", "synthetic");
    expect(fromToml({ name: "dev" })).toEqual({
      account: "selected-account",
      accessUrl: "https://selected-account.snowflakecomputing.com",
    });
  });
  it("uses the default_connection_name profile without named or generic overlays", async () => {
    await file(
      "config.toml",
      'default_connection_name="dev"\n[connections.dev]\naccount="org-account"\nuser="profile-user"\nwarehouse="PROFILE"\nauthenticator="oauth"\ntoken="profile-token"',
    );
    vi.stubEnv("SNOWFLAKE_USER", "generic-user");
    vi.stubEnv("SNOWFLAKE_SCHEMA", "GENERIC_SCHEMA");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEV_WAREHOUSE", "NAMED");
    const options = fromToml();
    expect(options).toMatchObject({ username: "profile-user", warehouse: "PROFILE" });
    expect(options).not.toHaveProperty("schema");
  });
  it.each(["SNOWFLAKE_CONNECTION_NAME", "SNOWFLAKE_DEFAULT_CONNECTION_NAME"])(
    "ignores %s when selecting a profile",
    async (variable) => {
      await file(
        "connections.toml",
        '[default]\naccount="default-account"\n[dev]\naccount="dev-account"',
      );
      vi.stubEnv(variable, "dev");
      expect(fromToml().account).toBe("default-account");
      expect(fromToml({ name: "dev" }).account).toBe("dev-account");
    },
  );
  it("connections.toml replaces config profiles instead of merging unrelated identities", async () => {
    await file(
      "config.toml",
      'default_connection_name="missing"\n[connections.missing]\naccount="wrong"',
    );
    await file("connections.toml", '[default]\naccount="right"');
    expect(() => fromToml()).toThrow(expect.objectContaining({ code: "CONFIG_NOT_FOUND" }));
  });
  it("never chooses the first arbitrary profile", async () => {
    await file("connections.toml", '[other]\naccount="org-account"');
    expect(() => fromToml()).toThrow(
      expect.objectContaining({
        code: "CONFIG_NOT_FOUND",
        details: { nextStep: nextSteps.discovery },
      }),
    );
  });
  it("handles BOM CRLF and config-relative token paths", async () => {
    await file(
      "connections.toml",
      '\uFEFF[default]\r\naccount="org-account"\r\ntoken_file_path="tokens/access"\r\n',
    );
    expect(profileFields({})).toMatchObject({
      tokenFilePath: path.join(directory, "tokens/access"),
    });
  });
  it("does not silently ignore malformed TOML", async () => {
    await file("config.toml", "[broken");
    expect(() => fromToml()).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("token files", () => {
  it("reads rotated opaque credentials and fails on revocation", async () => {
    await file("token", "opaque-one\n");
    await file(
      "connections.toml",
      '[default]\naccount="org-account"\nauthenticator="oauth"\ntoken_file_path="token"',
    );
    const options = fromToml();
    expect(options.token).toBe("opaque-one");
    await file("replacement", "opaque-two");
    await rename(path.join(directory, "replacement"), path.join(directory, "token"));
    expect(options.token).toBe("opaque-two");
    await file("token", "");
    expect(() => options.token).toThrow(expect.objectContaining({ code: "AUTH_FAILED" }));
  });
  it("selects a token file that is missing, and fails when the token is read", async () => {
    await file(
      "connections.toml",
      '[default]\naccount="org-account"\nauthenticator="oauth"\ntoken_file_path="missing"',
    );
    const options = fromToml();
    expect(() => options.token).toThrow(
      expect.objectContaining({
        code: "AUTH_FAILED",
        message: "Cannot read the selected token file",
      }),
    );
  });
});
