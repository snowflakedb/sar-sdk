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
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnectionOptions, fromTokenFile, authProviderIds } from "../src/auth.js";
import { AuthManager } from "../src/auth-manager.js";
import { profileFields, detect } from "../src/config.js";

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
  it("preserves generic private endpoint defaults for a matching profile account", async () => {
    await file(
      "connections.toml",
      '[dev]\naccount="same-account"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "same-account");
    vi.stubEnv("SNOWFLAKE_HOST", "private.invalid");
    vi.stubEnv("SNOWFLAKE_PORT", "8443");
    expect(await profileFields({ name: "dev" })).toMatchObject({
      account: "same-account",
      host: "private.invalid",
      port: "8443",
    });
  });
  it("replaces unbound generic targets coherently when a profile selects another account", async () => {
    await file(
      "connections.toml",
      '[dev]\naccount="selected-account"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_HOST", "generic.invalid");
    vi.stubEnv("SNOWFLAKE_PORT", "8443");
    const fields = await profileFields({ name: "dev" });
    expect(fields).toMatchObject({ account: "selected-account", token: "synthetic" });
    expect(fields?.host).toBeUndefined();
    expect(fields?.port).toBeUndefined();
  });
  it("does not inherit generic credentials into a different profile account", async () => {
    await file("connections.toml", '[dev]\naccount="selected-account"');
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
    vi.stubEnv("SNOWFLAKE_TOKEN", "synthetic");
    await expect(profileFields({ name: "dev" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("uses selected profile, named overrides, profile fields, then generic defaults", async () => {
    await file(
      "config.toml",
      'default_connection_name="dev"\n[connections.dev]\naccount="org-account"\nuser="profile-user"\nwarehouse="PROFILE"\nauthenticator="oauth"\ntoken="profile-token"',
    );
    vi.stubEnv("SNOWFLAKE_USER", "generic-user");
    vi.stubEnv("SNOWFLAKE_SCHEMA", "GENERIC_SCHEMA");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEV_WAREHOUSE", "NAMED");
    expect(await profileFields({})).toMatchObject({
      username: "profile-user",
      warehouse: "NAMED",
      schema: "GENERIC_SCHEMA",
    });
    expect(await profileFields({ warehouse: "EXPLICIT" })).toMatchObject({ warehouse: "EXPLICIT" });
  });
  it("connections.toml replaces config profiles instead of merging unrelated identities", async () => {
    await file(
      "config.toml",
      'default_connection_name="missing"\n[connections.missing]\naccount="wrong"',
    );
    await file("connections.toml", '[default]\naccount="right"');
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });
  it("never chooses the first arbitrary profile", async () => {
    await file("connections.toml", '[other]\naccount="org-account"');
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });
  it("handles BOM CRLF and config-relative token paths", async () => {
    await file(
      "connections.toml",
      '\uFEFF[default]\r\naccount="org-account"\r\ntoken_file_path="tokens/access"\r\n',
    );
    expect(await profileFields({})).toMatchObject({
      tokenFilePath: path.join(directory, "tokens/access"),
    });
  });
  it("does not silently ignore malformed TOML", async () => {
    await file("config.toml", "[broken");
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("selected profile bypasses standalone discovery", () => {
    const manager = new AuthManager({ connection: { name: "dev" } });
    expect(manager.providers.map((provider) => provider.id)).toEqual([authProviderIds.profile]);
  });
  it("does not use NODE_ENV alone as caller-fallback evidence", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("npm_lifecycle_event", "test");
    vi.stubEnv("CI", "true");
    expect((await detect()).environment).toBe("unknown");
  });
});

describe("provider contract", () => {
  it("rejects duplicates and empty lists disable discovery", async () => {
    const provider = { id: "same", resolve: async () => undefined };
    expect(() => createConnectionOptions([provider, provider])).toThrow();
    const manager = new AuthManager({ auth: { providers: [] } });
    await expect(manager.source()).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
  });
  it("reads rotated opaque credentials and fails on revocation", async () => {
    await file("token", "opaque-one");
    const provider = fromTokenFile({
      id: "file",
      path: path.join(directory, "token"),
      type: "oauth",
      target: { account: "org-account" },
    });
    const source = await provider.resolve({ connection: {} });
    expect(await source?.acquire()).toEqual({ type: "oauth", token: "opaque-one" });
    await file("replacement", "opaque-two");
    await rename(path.join(directory, "replacement"), path.join(directory, "token"));
    expect(await source?.acquire()).toEqual({ type: "oauth", token: "opaque-two" });
    await file("token", "");
    await expect(source?.acquire()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
  it("distinguishes optional absence from explicit missing files", async () => {
    const base = { id: "file", path: path.join(directory, "missing"), type: "oauth" as const };
    expect(
      await fromTokenFile({ ...base, optional: true }).resolve({ connection: {} }),
    ).toBeUndefined();
    await expect(fromTokenFile(base).resolve({ connection: {} })).rejects.toMatchObject({
      code: "AUTH_NOT_FOUND",
    });
  });
  it("sticks to the selected source when acquisition fails", async () => {
    const fallback = vi.fn();
    const manager = new AuthManager({
      auth: {
        providers: [
          {
            id: "first",
            async resolve() {
              return {
                target: { account: "org-account" },
                async acquire() {
                  throw new Error("rejected");
                },
              };
            },
          },
          { id: "fallback", resolve: fallback },
        ],
      },
    });
    await expect(manager.acquire(undefined)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(manager.acquire(undefined)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(fallback).not.toHaveBeenCalled();
  });
});
