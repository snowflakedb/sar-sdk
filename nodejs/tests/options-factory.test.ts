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
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type snowflake from "snowflake-sdk";
import {
  createConnectionOptions,
  fromDefault,
  fromPlatform,
  fromToml,
} from "../src/connection-options/index.js";
import {
  optionsScope,
  snapshotProvider,
  unconfiguredOptions,
  type ConnectionOptionsProvider,
} from "../src/connection-options/connection-options.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { createSarClient } from "../src/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { HttpTransport } from "../src/core/http.js";
import { fakeDriver } from "./fake-driver.js";

// Synthetic platform token mounts; no real file under /snowflake is ever read.
const mountedFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const missing = () => Object.assign(new Error("Synthetic absent mount"), { code: "ENOENT" });
  return {
    ...actual,
    existsSync: vi.fn((...args: Parameters<typeof actual.existsSync>) => {
      const filename = String(args[0]);
      return filename.startsWith("/snowflake/")
        ? mountedFiles.has(filename)
        : actual.existsSync(...args);
    }),
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const filename = String(args[0]);
      if (!filename.startsWith("/snowflake/")) return actual.readFileSync(...args);
      if (!mountedFiles.has(filename)) throw missing();
      return mountedFiles.get(filename);
    }),
  };
});

const platformToken = "/snowflake/session/token";
let directory: string;
beforeEach(async () => {
  mountedFiles.clear();
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-options-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const connection = (): snowflake.ConnectionOptions => ({
  account: "test",
  authenticator: "OAUTH",
  token: "synthetic",
});
const toml = async (contents: string) => {
  const filename = path.join(directory, "connections.toml");
  await writeFile(filename, contents, { mode: 0o600 });
  return filename;
};
const thrown = (code: string) => expect.objectContaining({ code });

describe("createConnectionOptions", () => {
  it("returns a frozen provider with only synchronous owner and caller getters", () => {
    const options = createConnectionOptions(connection());
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.keys(options).sort()).toEqual(["getCallerOptions", "getOwnerOptions"]);
    expect(options).not.toHaveProperty("diagnostics");
    expect(options).not.toHaveProperty("close");
    // A synchronous getter returns options, not a promise.
    expect(options.getOwnerOptions()).not.toBeInstanceOf(Promise);
    expect(options.getCallerOptions("alice")).not.toBeInstanceOf(Promise);
  });
  it("forces the application and keep-alive fields and derives the access URL", () => {
    const options = createConnectionOptions({
      ...connection(),
      application: "SomethingElse",
      clientSessionKeepAlive: true,
      serverSessionKeepAlive: true,
      role: "APP_ROLE",
    });
    const forced = {
      accessUrl: "https://test.snowflakecomputing.com",
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
      serverSessionKeepAlive: false,
    };
    expect(options.getOwnerOptions()).toMatchObject({
      ...forced,
      account: "test",
      authenticator: "OAUTH",
      token: "synthetic",
      role: "APP_ROLE",
    });
    expect(options.getCallerOptions("alice")).toMatchObject(forced);
  });
  it.each([
    [{ host: "private.example.invalid" }, "https://private.example.invalid"],
    [{ accessUrl: "https://explicit.example.invalid" }, "https://explicit.example.invalid"],
    [{ account: "org-acct", port: 8443 }, "https://org-acct.snowflakecomputing.com:8443"],
  ])("derives the endpoint from %o", (fields, accessUrl) => {
    const options = createConnectionOptions({
      ...fields,
      authenticator: "OAUTH",
      token: "synthetic",
    });
    expect(options.getOwnerOptions().accessUrl).toBe(accessUrl);
    expect(options.getCallerOptions("alice").accessUrl).toBe(accessUrl);
  });
  it.each([{}, { account: "not valid!" }, { host: "bad/host" }, { accessUrl: "http://insecure" }])(
    "rejects connection options %o that identify no HTTPS endpoint when the options are read",
    (fields) => {
      const options = createConnectionOptions({ ...fields, token: "synthetic" });
      expect(() => options.getOwnerOptions()).toThrow(thrown("CONFIG_INVALID"));
      expect(() => options.getCallerOptions("alice")).toThrow(thrown("CONFIG_INVALID"));
    },
  );
  it("validates the endpoint before reading credentials", () => {
    const token = vi.fn(() => "synthetic");
    const input = { host: "bad/host" } as snowflake.ConnectionOptions;
    Object.defineProperty(input, "token", { enumerable: true, get: token });
    const options = createConnectionOptions(input);
    expect(() => options.getOwnerOptions()).toThrow(thrown("CONFIG_INVALID"));
    expect(() => options.getCallerOptions("alice")).toThrow(thrown("CONFIG_INVALID"));
    expect(token).not.toHaveBeenCalled();
  });
  it("composes the caller's token onto the connection's token, never replacing it", () => {
    const options = createConnectionOptions(connection());
    expect(options.getOwnerOptions().token).toBe("synthetic");
    expect(options.getCallerOptions("alice")).toEqual({
      ...options.getOwnerOptions(),
      token: "synthetic.alice",
    });
  });
  it.each(["oauth", "pat"] as const)(
    "composes the same way for any %s token, not only a platform token",
    (type) => {
      const options = createConnectionOptions({
        account: "test",
        authenticator: type === "pat" ? "PROGRAMMATIC_ACCESS_TOKEN" : "OAUTH",
        token: "synthetic",
      });
      expect(options.getCallerOptions("caller").token).toBe("synthetic.caller");
    },
  );
  it.each([
    ["missing", {}],
    ["empty", { token: "" }],
    ["not a string", { token: 42 as never }],
  ])("rejects caller options without a usable connection token (%s)", (_label, fields) => {
    const options = createConnectionOptions({ account: "test", authenticator: "OAUTH", ...fields });
    expect(options.getOwnerOptions()).toMatchObject({ account: "test" });
    expect(() => options.getCallerOptions("alice")).toThrow(
      expect.objectContaining({
        code: "AUTH_NOT_SUPPORTED",
        details: expect.objectContaining({ nextStep: expect.stringContaining("callerAsOwner") }),
      }),
    );
  });
  it.each(["oauth", "OAUTH", "programmatic_access_token", "PROGRAMMATIC_ACCESS_TOKEN"])(
    "composes for the token authenticator %s, whatever its case",
    (authenticator) => {
      const options = createConnectionOptions({ account: "test", authenticator, token: "owner" });
      expect(options.getCallerOptions("alice").token).toBe("owner.alice");
    },
  );
  it.each([
    ["the default authenticator", {}],
    ["SNOWFLAKE with a password", { authenticator: "SNOWFLAKE", password: "owner-password" }],
    ["SNOWFLAKE_JWT", { authenticator: "SNOWFLAKE_JWT", username: "u", privateKeyPath: "/k" }],
    ["EXTERNALBROWSER", { authenticator: "externalbrowser", username: "u" }],
    ["USERNAME_PASSWORD_MFA", { authenticator: "USERNAME_PASSWORD_MFA", password: "p" }],
    ["OAUTH_AUTHORIZATION_CODE", { authenticator: "OAUTH_AUTHORIZATION_CODE" }],
    ["OAUTH_CLIENT_CREDENTIALS", { authenticator: "OAUTH_CLIENT_CREDENTIALS" }],
    ["WORKLOAD_IDENTITY", { authenticator: "WORKLOAD_IDENTITY" }],
    ["an Okta URL", { authenticator: "https://example.okta.com" }],
    ["an unknown authenticator", { authenticator: "NOT_A_REAL_ONE" }],
  ])(
    "refuses to compose onto %s even with an incidental token, which the login would ignore",
    (_label, fields) => {
      const options = createConnectionOptions({ account: "test", token: "incidental", ...fields });
      expect(options.getOwnerOptions().token).toBe("incidental");
      let error: unknown;
      try {
        options.getCallerOptions("caller-token");
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "AUTH_NOT_SUPPORTED",
        details: { nextStep: expect.stringContaining("callerAsOwner") },
      });
      // Neither the caller's token nor the owner's credentials reach the error.
      expect(JSON.stringify(error)).not.toMatch(/caller-token|incidental|owner-password/);
      // callerAsOwner is the explicit way to run these connections.
      const owner = createConnectionOptions(
        { account: "test", token: "incidental", ...fields },
        { callerAsOwner: true },
      );
      expect(owner.getCallerOptions("caller-token")).toEqual(owner.getOwnerOptions());
    },
  );
  it("never reaches the driver with an owner-identity session for a password connection", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        authenticator: "SNOWFLAKE",
        password: "owner-password",
        token: "incidental-owner-token",
      }),
    });
    try {
      await expect(
        client.asCaller({ token: "caller-token" }).query("SELECT 1"),
      ).rejects.toMatchObject({
        code: "AUTH_NOT_SUPPORTED",
      });
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
  it("returns the owner options as caller options only with callerAsOwner", () => {
    const options = createConnectionOptions(
      { account: "test", password: "synthetic" },
      { callerAsOwner: true },
    );
    expect(options.getCallerOptions("alice")).toEqual(options.getOwnerOptions());
    // Even with a token, the caller's token is not appended.
    const withToken = createConnectionOptions(connection(), { callerAsOwner: true });
    expect(withToken.getCallerOptions("alice").token).toBe("synthetic");
    expect(withToken.getCallerOptions("bob")).toEqual(withToken.getOwnerOptions());
  });
  it.each(["", " ", "\t\n", undefined, null, 42, {}])(
    "rejects the caller token %o, with or without callerAsOwner",
    (token) => {
      for (const callerAsOwner of [false, true])
        expect(() =>
          createConnectionOptions(connection(), { callerAsOwner }).getCallerOptions(token as never),
        ).toThrow(thrown("CALLER_CONTEXT_REQUIRED"));
    },
  );
  it("reads a token getter on every call, so a rotated token is picked up", () => {
    let current = "first";
    const rotating = connection();
    Object.defineProperty(rotating, "token", { enumerable: true, get: () => current });
    const options = createConnectionOptions(rotating);
    expect(options.getOwnerOptions().token).toBe("first");
    expect(options.getCallerOptions("alice").token).toBe("first.alice");
    current = "second";
    expect(options.getOwnerOptions().token).toBe("second");
    expect(options.getCallerOptions("alice").token).toBe("second.alice");
    // Returned options hold the value, not the getter.
    expect(Object.getOwnPropertyDescriptor(options.getOwnerOptions(), "token")).toMatchObject({
      value: "second",
    });
  });
  it("does not read the connection's token until options are requested", () => {
    const read = vi.fn(() => "synthetic");
    const lazy = { account: "test" } as snowflake.ConnectionOptions;
    Object.defineProperty(lazy, "token", { enumerable: true, get: read });
    const options = createConnectionOptions(lazy);
    expect(read).not.toHaveBeenCalled();
    options.getOwnerOptions();
    expect(read).toHaveBeenCalledOnce();
  });
  it("returns independent mutable snapshots and ignores later changes to the input", () => {
    const input = connection();
    const options = createConnectionOptions(input);
    const first = options.getOwnerOptions();
    first.token = "changed";
    first.account = "changed";
    expect(options.getOwnerOptions()).toMatchObject({ account: "test", token: "synthetic" });
    expect(options.getOwnerOptions()).not.toBe(options.getOwnerOptions());
    // The descriptors are copied at creation: replacing the input's values has no effect.
    input.account = "later";
    expect(options.getOwnerOptions().account).toBe("test");
    expect(options.getCallerOptions("alice")).not.toBe(options.getCallerOptions("alice"));
  });
  it.each([[null], [undefined], [[]], ["account"], [42]])(
    "rejects connection options %o that aren't a plain object",
    (value) => {
      expect(() => createConnectionOptions(value as never)).toThrow(thrown("INVALID_OPTIONS"));
    },
  );
  it("validates the second argument", () => {
    expect(() =>
      createConnectionOptions(connection(), { callerFallback: "error" } as never),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: expect.stringContaining("callerFallback"),
      }),
    );
    for (const removed of [
      "environment",
      "platform",
      "interactive",
      "driverOptions",
      "logger",
      "authTimeoutMs",
      "connection",
    ])
      expect(() => createConnectionOptions(connection(), { [removed]: "x" } as never)).toThrow(
        thrown("INVALID_OPTIONS"),
      );
    expect(() => createConnectionOptions(connection(), [] as never)).toThrow(
      thrown("INVALID_OPTIONS"),
    );
    expect(() => createConnectionOptions(connection(), null as never)).toThrow(
      thrown("INVALID_OPTIONS"),
    );
    for (const callerAsOwner of ["true", 1, null, {}])
      expect(() =>
        createConnectionOptions(connection(), { callerAsOwner: callerAsOwner as never }),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "callerAsOwner must be a boolean",
        }),
      );
    expect(() => createConnectionOptions(connection(), {})).not.toThrow();
    expect(() => createConnectionOptions(connection(), { callerAsOwner: undefined })).not.toThrow();
  });
});

describe("fromPlatform", () => {
  it("reads the service's current mounted token on every call", () => {
    mountedFiles.set(platformToken, "first\n");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    vi.stubEnv("SNOWFLAKE_ROLE", "APP_ROLE");
    const options = createConnectionOptions(fromPlatform());
    expect(options.getOwnerOptions()).toMatchObject({
      account: "test",
      role: "APP_ROLE",
      authenticator: "OAUTH",
      token: "first",
      accessUrl: "https://test.snowflakecomputing.com",
    });
    expect(options.getCallerOptions("caller").token).toBe("first.caller");
    mountedFiles.set(platformToken, "second");
    expect(options.getOwnerOptions().token).toBe("second");
    expect(options.getCallerOptions("caller").token).toBe("second.caller");
  });
  it("uses the endpoint the platform sets", () => {
    mountedFiles.set(platformToken, "token");
    vi.stubEnv("SNOWFLAKE_HOST", "platform.example.invalid");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    expect(fromPlatform().accessUrl).toBe("https://platform.example.invalid");
  });
  it("fails closed when the mounted token is removed or empty", () => {
    mountedFiles.set(platformToken, "first");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const options = createConnectionOptions(fromPlatform());
    mountedFiles.set(platformToken, "  \n");
    expect(() => options.getOwnerOptions()).toThrow(thrown("AUTH_FAILED"));
    expect(() => options.getCallerOptions("alice")).toThrow(thrown("AUTH_FAILED"));
    mountedFiles.delete(platformToken);
    expect(() => options.getOwnerOptions()).toThrow(thrown("AUTH_FAILED"));
  });
  it("reads only /snowflake/session/token, not another mount", () => {
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    mountedFiles.set("/snowflake/secrets-client/snowflake-session/token", "elsewhere");
    expect(() => fromPlatform()).toThrow(thrown("AUTH_NOT_FOUND"));
    mountedFiles.set(platformToken, "token");
    expect(fromPlatform().token).toBe("token");
  });
  it("treats an explicit undefined as no options", () => {
    mountedFiles.set(platformToken, "token");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    expect((fromPlatform as (input: unknown) => { token?: string })(undefined).token).toBe("token");
  });
  it("requires the platform's endpoint environment", () => {
    mountedFiles.set(platformToken, "token");
    expect(() => fromPlatform()).toThrow(thrown("CONFIG_INVALID"));
  });
  it("reports the missing token, not a missing endpoint, outside the platform", () => {
    // No token is mounted and no SNOWFLAKE_* endpoint is set, as on a developer machine.
    expect(() => fromPlatform()).toThrow(thrown("AUTH_NOT_FOUND"));
  });
  it.each([{ platform: "spcs" }, { platform: "serverless" }, {}, null])(
    "takes no options, rejecting %o",
    (input) => {
      mountedFiles.set(platformToken, "token");
      vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
      expect(() => (fromPlatform as (input: unknown) => unknown)(input)).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "fromPlatform takes no options",
        }),
      );
    },
  );
});

describe("fromDefault", () => {
  it("reads the platform token when the service has mounted one", async () => {
    await toml('[default]\naccount="profile"\nauthenticator="oauth"\ntoken="local"');
    mountedFiles.set(platformToken, "platform\n");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "platform-account");
    const options = createConnectionOptions(fromDefault());
    expect(options.getOwnerOptions()).toMatchObject({
      account: "platform-account",
      token: "platform",
    });
    expect(options.getCallerOptions("alice").token).toBe("platform.alice");
  });
  it("reads the default SnowCLI profile when no platform token is mounted", async () => {
    await toml('[default]\naccount="profile"\nauthenticator="oauth"\ntoken="local"');
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "platform-account");
    const options = createConnectionOptions(fromDefault(), { callerAsOwner: true });
    expect(options.getOwnerOptions()).toMatchObject({ account: "profile", token: "local" });
    expect(options.getCallerOptions("alice").token).toBe("local");
  });
  it("uses default_connection_name for the local profile", async () => {
    await toml(
      'default_connection_name="dev"\n[dev]\naccount="dev-account"\n[default]\naccount="other"',
    );
    expect(fromDefault().account).toBe("dev-account");
  });
  it("fails with the profile error, not a platform one, when neither source exists", () => {
    expect(() => fromDefault()).toThrow(thrown("CONFIG_NOT_FOUND"));
  });
  it.each([{ name: "dev" }, { configFile: "x.toml" }, { platform: "spcs" }, {}, null])(
    "takes no options, rejecting %o",
    async (input) => {
      await toml('[default]\naccount="profile"');
      expect(() => (fromDefault as (input: unknown) => unknown)(input)).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "fromDefault takes no options",
        }),
      );
    },
  );
  it("treats an explicit undefined as no options", async () => {
    await toml('[default]\naccount="profile"');
    expect((fromDefault as (input: unknown) => { account?: string })(undefined).account).toBe(
      "profile",
    );
  });
});

describe("fromToml", () => {
  it("reads the selected profile without environment overlays or inferred names", async () => {
    const configFile = await toml(
      '[dev]\naccount="test"\nauthenticator="oauth"\ntoken="from-profile"\n[other]\naccount="other"',
    );
    vi.stubEnv("SNOWFLAKE_CONNECTION_NAME", "other");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "env-account");
    vi.stubEnv("SNOWFLAKE_TOKEN", "from-env");
    mountedFiles.set(platformToken, "platform");
    const options = createConnectionOptions(fromToml({ configFile, name: "dev" }));
    expect(options.getOwnerOptions()).toMatchObject({
      account: "test",
      token: "from-profile",
      accessUrl: "https://test.snowflakecomputing.com",
    });
    expect(options.getCallerOptions("alice").token).toBe("from-profile.alice");
  });
  it("doesn't fall through to another source when the selection is invalid", async () => {
    const configFile = await toml('[dev]\naccount="test"');
    mountedFiles.set(platformToken, "platform");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    expect(() => fromToml({ configFile, name: "other" })).toThrow(thrown("CONFIG_NOT_FOUND"));
    expect(() => fromToml({ configFile: path.join(directory, "missing.toml") })).toThrow(
      thrown("CONFIG_NOT_FOUND"),
    );
  });
  it("reads the current token file and fails closed after removal", async () => {
    const tokenFile = path.join(directory, "token");
    await writeFile(tokenFile, "first\n");
    const configFile = await toml(
      `[dev]\naccount="test"\nauthenticator="oauth"\ntoken_file_path='${tokenFile}'`,
    );
    const options = createConnectionOptions(fromToml({ configFile, name: "dev" }));
    expect(options.getCallerOptions("caller").token).toBe("first.caller");
    await writeFile(tokenFile, "second");
    expect(options.getOwnerOptions().token).toBe("second");
    await rm(tokenFile);
    expect(() => options.getOwnerOptions()).toThrow(thrown("AUTH_FAILED"));
    await writeFile(tokenFile, " ");
    expect(() => options.getOwnerOptions()).toThrow(thrown("AUTH_FAILED"));
  });
  it("requires an explicit authenticator for tokens and rejects ambiguous token sources", async () => {
    const noAuthenticator = await toml('[dev]\naccount="test"\ntoken="synthetic"');
    expect(() => fromToml({ configFile: noAuthenticator, name: "dev" })).toThrow(
      thrown("CONFIG_INVALID"),
    );
    const both = await toml(
      '[dev]\naccount="test"\nauthenticator="oauth"\ntoken="synthetic"\ntoken_file_path="/synthetic"',
    );
    expect(() => fromToml({ configFile: both, name: "dev" })).toThrow(thrown("CONFIG_INVALID"));
  });
  it("validates its input", () => {
    expect(() => fromToml({ environmentOverrides: "yes" } as never)).toThrow(
      thrown("INVALID_OPTIONS"),
    );
    expect(() => fromToml({ name: "" })).toThrow(thrown("INVALID_OPTIONS"));
    expect(() => fromToml({ configFile: 42 as never })).toThrow(thrown("INVALID_OPTIONS"));
  });
});

describe("optionsScope", () => {
  it("makes an owner scope with no context, calling only the owner getter", () => {
    const provider = createConnectionOptions(connection());
    const scope = optionsScope(provider);
    expect(scope).toMatchObject({ mode: "owner", contextKey: undefined });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(scope.options()).toEqual(provider.getOwnerOptions());
  });
  it("makes a caller scope keyed by a digest of the caller token", () => {
    const provider = createConnectionOptions(connection());
    const alice = optionsScope(provider, { token: "alice" });
    expect(alice.mode).toBe("caller");
    expect(alice.contextKey).toBe(createHash("sha256").update("alice").digest("base64url"));
    expect(alice.contextKey).not.toContain("alice");
    expect(alice.options().token).toBe("synthetic.alice");
    const viaHeaders = optionsScope(provider, {
      headers: new Headers({ "sf-context-current-user-token": "alice" }),
    });
    expect(viaHeaders.contextKey).toBe(alice.contextKey);
    expect(optionsScope(provider, { token: "bob" }).contextKey).not.toBe(alice.contextKey);
    // Each view is its own scope, even for identical tokens.
    expect(optionsScope(provider, { token: "alice" })).not.toBe(alice);
  });
  it("requires caller context without callerAsOwner, before reading credentials", () => {
    const read = vi.fn(() => "synthetic");
    const lazy = { account: "test" } as snowflake.ConnectionOptions;
    Object.defineProperty(lazy, "token", { enumerable: true, get: read });
    const provider = createConnectionOptions(lazy);
    expect(() => optionsScope(provider, { headers: new Headers() })).toThrow(
      thrown("CALLER_CONTEXT_REQUIRED"),
    );
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    [null, "INVALID_OPTIONS"],
    [{ cookie: "alice" }, "INVALID_OPTIONS"],
    [{ headers: new Headers(), token: "alice" }, "INVALID_OPTIONS"],
    [{ headers: {} }, "INVALID_OPTIONS"],
    [{ token: " " }, "CALLER_CONTEXT_REQUIRED"],
    [{ headers: { get: () => " " } }, "CALLER_CONTEXT_REQUIRED"],
  ])("rejects caller context %o with or without callerAsOwner", (context, code) => {
    for (const callerAsOwner of [false, true])
      expect(() =>
        optionsScope(createConnectionOptions(connection(), { callerAsOwner }), context as never),
      ).toThrow(thrown(code));
  });
  it("makes owner-mode scopes for a callerAsOwner provider, with or without a token", () => {
    const provider = createConnectionOptions(connection(), { callerAsOwner: true });
    for (const context of [
      { token: "alice" },
      { headers: new Headers({ "sf-context-current-user-token": "alice" }) },
      { headers: new Headers() },
    ]) {
      const scope = optionsScope(provider, context);
      expect(scope).toMatchObject({ mode: "owner", contextKey: undefined });
      expect(scope.options().token).toBe("synthetic");
    }
  });
  it("keeps callerAsOwner through snapshotProvider", () => {
    const provider = createConnectionOptions(connection(), { callerAsOwner: true });
    expect(optionsScope(snapshotProvider(provider), { token: "alice" }).mode).toBe("owner");
    const strict = createConnectionOptions(connection());
    expect(optionsScope(snapshotProvider(strict), { token: "alice" }).mode).toBe("caller");
  });
  it("doesn't treat a lookalike structural provider as callerAsOwner", () => {
    const lookalike = {
      getOwnerOptions: () => connection(),
      getCallerOptions: () => connection(),
      callerAsOwner: true,
    };
    expect(optionsScope(snapshotProvider(lookalike), { token: "alice" }).mode).toBe("caller");
  });
  it.each([
    ["sessionToken", { account: "test", sessionToken: "synthetic" }],
    ["masterToken", { account: "test", masterToken: "synthetic" }],
    ["session_token", { account: "test", session_token: "synthetic" }],
    ["master_token", { account: "test", master_token: "synthetic" }],
  ])("rejects inherited session credentials (%s) from options()", (_label, fields) => {
    // The factory passes them through; owned components refuse to use them.
    const provider = createConnectionOptions(fields as never, { callerAsOwner: true });
    expect(provider.getOwnerOptions()).toMatchObject(fields);
    expect(() => optionsScope(provider).options()).toThrow(thrown("AUTH_NOT_SUPPORTED"));
    expect(() => optionsScope(provider, { token: "alice" }).options()).toThrow(
      thrown("AUTH_NOT_SUPPORTED"),
    );
  });
  it("rejects session credentials in caller options too", () => {
    const provider = createConnectionOptions({
      ...connection(),
      sessionToken: "synthetic",
    } as never);
    expect(() => optionsScope(provider, { token: "alice" }).options()).toThrow(
      thrown("AUTH_NOT_SUPPORTED"),
    );
  });
  it("rejects a non-string authenticator and non-object returns", () => {
    const invalid = (value: unknown) =>
      optionsScope({
        getOwnerOptions: () => value as never,
        getCallerOptions: () => value as never,
      });
    expect(() => invalid({ account: "test", authenticator: 42 }).options()).toThrow(
      thrown("AUTH_FAILED"),
    );
    for (const value of [null, undefined, [], "options", 42])
      expect(() => invalid(value).options()).toThrow(thrown("AUTH_FAILED"));
  });
  it("returns a copy of the provider's options", () => {
    const shared = connection();
    const scope = optionsScope({ getOwnerOptions: () => shared, getCallerOptions: () => shared });
    const first = scope.options();
    first.token = "changed";
    expect(shared.token).toBe("synthetic");
    expect(scope.options().token).toBe("synthetic");
  });
});

describe("providers", () => {
  it("rejects every call from the unconfigured default", async () => {
    expect(() => unconfiguredOptions.getOwnerOptions()).toThrow(thrown("AUTH_NOT_FOUND"));
    expect(() => unconfiguredOptions.getCallerOptions("alice")).toThrow(thrown("AUTH_NOT_FOUND"));
    const fake = fakeDriver();
    const client = createSarClient({ driver: fake.driver });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
    expect(fake.connections).toHaveLength(0);
    await client.close();
  });
  it("snapshots structural methods while preserving receivers", () => {
    const custom = {
      token: "synthetic",
      getOwnerOptions() {
        return { account: "test", token: this.token };
      },
      getCallerOptions(token: string) {
        return { account: "test", token };
      },
    };
    const provider = snapshotProvider(custom);
    expect(Object.isFrozen(provider)).toBe(true);
    custom.getOwnerOptions = () => {
      throw Error("changed");
    };
    expect(provider.getOwnerOptions().token).toBe("synthetic");
    expect(optionsScope(provider, { token: "alice" }).options().token).toBe("alice");
  });
  it("reads the caller's token header once per view", () => {
    const provider = snapshotProvider({
      getOwnerOptions: () => connection(),
      getCallerOptions: (token) => ({ ...connection(), token }),
    });
    const get = vi.fn(() => "caller");
    const scope = optionsScope(provider, { headers: { get } });
    get.mockReturnValue("changed");
    expect(scope.options().token).toBe("caller");
    expect(get).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    {},
    { getOwnerOptions: () => connection() },
    { getCallerOptions: () => connection() },
    { getOwnerOptions: "no", getCallerOptions: "no" },
  ])("rejects a provider that doesn't implement both getters: %o", (provider) => {
    expect(() => snapshotProvider(provider as never)).toThrow(thrown("INVALID_OPTIONS"));
    if (provider !== null)
      expect(() => createSarClient({ connectionOptions: provider as never })).toThrow(
        thrown("INVALID_OPTIONS"),
      );
  });
});

describe("components built on connection options", () => {
  it.each([
    [null],
    [[]],
    [{ account: "test", sessionToken: "synthetic" }],
    [{ account: "test", masterToken: "synthetic" }],
    [{ account: "test", authenticator: 42 }],
  ])(
    "rejects malformed or inherited-session options before creating a driver: %o",
    async (value) => {
      const fake = fakeDriver();
      const get = () => value as never;
      const manager = createConnectionManager(
        { getOwnerOptions: get, getCallerOptions: get },
        { driver: fake.driver },
      );
      await expect(manager.connect()).rejects.toHaveProperty("code");
      expect(fake.connections).toHaveLength(0);
      await manager.close();
    },
  );
  it("rejects a caller session on a connection with no token to extend, before creating a driver", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({ account: "test", password: "synthetic" }),
    });
    await expect(client.asCaller({ token: "alice" }).query("SELECT 1")).rejects.toMatchObject({
      code: "AUTH_NOT_SUPPORTED",
    });
    await client.query("SELECT 1");
    expect(fake.connections).toHaveLength(1);
    await client.close();
  });
  it.each(["OAUTH", "PROGRAMMATIC_ACCESS_TOKEN"])(
    "uses a structural %s provider for HTTP without SQL",
    async (authenticator) => {
      const fetch = vi
        .spyOn(HttpTransport.prototype, "fetch")
        .mockResolvedValue(new Response("ok"));
      const get = () => ({ account: "test", authenticator, token: "synthetic" });
      const http = createFetchClient({ getOwnerOptions: get, getCallerOptions: get });
      try {
        await http.fetch("/api/v2/test");
        expect(
          new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
            "x-snowflake-authorization-token-type",
          ),
        ).toBe(authenticator);
      } finally {
        await http.close();
      }
    },
  );
  it.each([
    { authenticator: "OAUTH", token: "synthetic", password: "conflicting" },
    { authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token: "synthetic", tokenFilePath: "/synthetic" },
    { token: "synthetic" },
    { authenticator: "OAUTH", token: " " },
  ])("does not guess HTTP bearer semantics from ambiguous native options: %o", async (fields) => {
    const fetch = vi.spyOn(HttpTransport.prototype, "fetch");
    const get = () => ({ account: "test", ...fields });
    const http = createFetchClient({ getOwnerOptions: get, getCallerOptions: get });
    await expect(http.fetch("/api/v2/test")).rejects.toMatchObject({
      code: "AUTH_NOT_SUPPORTED_FOR_REST",
    });
    expect(fetch).not.toHaveBeenCalled();
    await http.close();
  });
  it("composes a structural provider with manager, query, and aggregate layers", async () => {
    const factory = createConnectionOptions(connection());
    const provider: ConnectionOptionsProvider = {
      getOwnerOptions: factory.getOwnerOptions,
      getCallerOptions: factory.getCallerOptions,
    };
    const fake = fakeDriver();
    const manager = createConnectionManager(provider, { driver: fake.driver });
    const queries = createQueryClient(manager);
    const client = createSarClient({ connectionOptions: provider, driver: fake.driver });
    try {
      expect((await queries.query("synthetic")).rowCount).toBe(1);
      expect((await client.query("synthetic")).rowCount).toBe(1);
      await client.asCaller({ token: "alice" }).query("synthetic");
      expect(fake.connections.map((c) => c.config.token)).toEqual([
        "synthetic",
        "synthetic",
        "synthetic.alice",
      ]);
    } finally {
      await queries.close();
      await manager.close();
      await client.close();
    }
  });
  it("sends the forced application and keep-alive fields to the driver", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        ...connection(),
        application: "Other",
        clientSessionKeepAlive: true,
      }),
    });
    try {
      await client.query("SELECT 1");
      await client.asCaller({ token: "alice" }).query("SELECT 1");
      for (const { config } of fake.connections)
        expect(config).toMatchObject({
          application: "SnowflakeAppRuntime",
          clientSessionKeepAlive: false,
          serverSessionKeepAlive: false,
          accessUrl: "https://test.snowflakecomputing.com",
        });
    } finally {
      await client.close();
    }
  });
  it("opens each new session with the current rotated token", async () => {
    let current = "first";
    const rotating = connection();
    Object.defineProperty(rotating, "token", { enumerable: true, get: () => current });
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(rotating),
    });
    try {
      await client.query("SELECT 1");
      current = "second";
      await client.query("SELECT 2");
      await client.asCaller({ token: "alice" }).query("SELECT 3");
      expect(fake.connections.map((c) => c.config.token)).toEqual([
        "first",
        "second",
        "second.alice",
      ]);
    } finally {
      await client.close();
    }
  });
  it("keeps absent and blank caller context distinct", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(connection()),
    });
    try {
      expect(() => client.asCaller({ headers: new Headers() })).toThrow(
        thrown("CALLER_CONTEXT_REQUIRED"),
      );
      expect(() => client.asCaller({ token: " " })).toThrow(thrown("CALLER_CONTEXT_REQUIRED"));
      expect(() => client.asCaller({ headers: { get: () => " " } })).toThrow(
        thrown("CALLER_CONTEXT_REQUIRED"),
      );
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
