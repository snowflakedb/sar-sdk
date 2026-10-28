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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type snowflake from "snowflake-sdk";
import { createConnectionOptions, fromToml, getCallerUserToken } from "../src/auth.js";
import {
  optionsScope,
  snapshotProvider,
  type ConnectionOptionsProvider,
} from "../src/auth-client.js";
import { endpoint, normalize, profileFields } from "../src/config.js";

// Observe every file read, so a test can show which files the SDK reads and when.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-auth-boundaries-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const target = { account: "org-account" };
const connection = (): snowflake.ConnectionOptions => ({
  ...target,
  authenticator: "OAUTH",
  token: "synthetic-token",
});
const configFile = (text: string) =>
  writeFile(path.join(directory, "connections.toml"), text, { mode: 0o600 });
const thrown = (code: string) => expect.objectContaining({ code });
/** Connection options whose token getter counts its reads. */
function countingConnection(fields: Partial<snowflake.ConnectionOptions> = {}) {
  const read = vi.fn(() => "synthetic-token");
  const options = { ...target, authenticator: "OAUTH", ...fields } as snowflake.ConnectionOptions;
  Object.defineProperty(options, "token", { enumerable: true, get: read });
  return { options, read };
}

describe("effective endpoint boundaries", () => {
  it.each([null, []])("rejects connection options that aren't an object: %o", (invalid) => {
    expect(() => createConnectionOptions(invalid as never)).toThrow(thrown("INVALID_OPTIONS"));
  });

  it.each([{ account: 42 }, { account: " " }, { account: "not valid!" }])(
    "rejects invalid connection option types when the options are read: %o",
    (invalid) => {
      const options = createConnectionOptions({ ...invalid, token: "synthetic" } as never);
      expect(() => options.getOwnerOptions()).toThrow(thrown("CONFIG_INVALID"));
      expect(() => options.getCallerOptions("alice")).toThrow(thrown("CONFIG_INVALID"));
    },
  );

  it("rejects conflicting host/accessUrl on the final connection options", () => {
    const options = createConnectionOptions({
      host: "other.invalid",
      accessUrl: "https://account.invalid",
      token: "synthetic",
    });
    expect(() => options.getOwnerOptions()).toThrow(thrown("CONFIG_INVALID"));
    expect(() => options.getCallerOptions("alice")).toThrow(thrown("CONFIG_INVALID"));
  });

  it("rejects an insecure effective endpoint, whatever the credentials", () => {
    const options = createConnectionOptions({
      ...connection(),
      accessUrl: "http://account.invalid",
    });
    expect(() => options.getOwnerOptions()).toThrow(thrown("CONFIG_INVALID"));
    expect(() => options.getCallerOptions("alice")).toThrow(thrown("CONFIG_INVALID"));
    expect(() => optionsScope(options).options()).toThrow(thrown("CONFIG_INVALID"));
    expect(() => optionsScope(options, { token: "alice" }).options()).toThrow(
      thrown("CONFIG_INVALID"),
    );
  });

  it("permits custom endpoints paired with the same account and SQL context", () => {
    const custom = {
      ...target,
      host: "private.account.invalid:8443",
      accessUrl: "https://private.account.invalid:8443/",
    };
    const options = createConnectionOptions({
      ...custom,
      authenticator: "OAUTH",
      token: "synthetic",
      warehouse: "APP",
      role: "READER",
    });
    for (const resolved of [options.getOwnerOptions(), options.getCallerOptions("alice")])
      expect(resolved).toMatchObject({
        ...custom,
        accessUrl: "https://private.account.invalid:8443",
        warehouse: "APP",
        role: "READER",
      });
    expect(endpoint(custom)).toBe("https://private.account.invalid:8443");
  });

  it("canonicalizes equivalent access URLs, replacing the configured spelling", () => {
    const options = createConnectionOptions({
      ...connection(),
      accessUrl: "https://custom.invalid:443/",
    });
    expect(options.getOwnerOptions().accessUrl).toBe("https://custom.invalid");
    expect(options.getCallerOptions("alice").accessUrl).toBe("https://custom.invalid");
    expect(optionsScope(options, { token: "alice" }).options().accessUrl).toBe(
      "https://custom.invalid",
    );
  });

  it("accepts equivalent origins without imposing the account's derived hostname", () => {
    expect(
      endpoint({ ...target, host: "CUSTOM.invalid:443", accessUrl: "https://custom.invalid/" }),
    ).toBe("https://custom.invalid");
    expect(endpoint({ host: "CUSTOM.invalid:443", accessUrl: "https://custom.invalid/" })).toBe(
      "https://custom.invalid",
    );
    expect(
      endpoint({ ...target, host: "custom.invalid", accessUrl: "https://custom.invalid:8443" }),
    ).toBe("https://custom.invalid:8443");
    expect(endpoint({ ...target, port: 8443 })).toBe(
      "https://org-account.snowflakecomputing.com:8443",
    );
  });

  it.each([
    { accessUrl: "https://first.invalid", host: "second.invalid" },
    { accessUrl: "https://first.invalid", host: "http://first.invalid" },
    { ...target, protocol: "http" },
    { host: "account.invalid", port: 0 },
    { host: "account.invalid", port: 70000 },
    { host: "account.invalid:443", accessUrl: "https://account.invalid:8443" },
    { accessUrl: "https://account.invalid:8443", port: 443 },
  ])("rejects inconsistent or invalid endpoint fields: %o", (fields) => {
    expect(() => endpoint(fields)).toThrow(thrown("CONFIG_INVALID"));
  });
});

describe("TOML profile boundaries", () => {
  it("does not inherit generic SNOWFLAKE_* values into a different profile identity", async () => {
    await configFile(
      '[default]\naccount="profile-account"\nuser="profile-user"\nauthenticator="oauth"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
    vi.stubEnv("SNOWFLAKE_TOKEN", "synthetic");
    expect(profileFields({})).toEqual({
      account: "profile-account",
      username: "profile-user",
      authenticator: "oauth",
    });
    expect(fromToml()).toEqual({
      account: "profile-account",
      username: "profile-user",
      authenticator: "oauth",
      accessUrl: "https://profile-account.snowflakecomputing.com",
    });
  });

  it("does not retarget profile credentials through named environment overrides", async () => {
    await configFile(
      '[default]\naccount="profile-account"\nuser="profile-user"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_USER", "another-user");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_ACCOUNT", "another-account");
    expect(fromToml()).toMatchObject({
      account: "profile-account",
      username: "profile-user",
      token: "synthetic",
    });
  });

  it("returns the profile's own SQL context and endpoint, without overlays or selectors", async () => {
    await configFile(
      '[default]\naccount="org-account"\nuser="profile-user"\nhost="custom.invalid"\nwarehouse="PROFILE"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_ACCOUNT", "ORG-ACCOUNT");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_WAREHOUSE", "NAMED");
    vi.stubEnv("SNOWFLAKE_SCHEMA", "GENERIC");
    const options = fromToml();
    expect(options).toEqual({
      account: "org-account",
      username: "profile-user",
      warehouse: "PROFILE",
      authenticator: "oauth",
      token: "synthetic",
      accessUrl: "https://custom.invalid",
    });
    // SQL context is the connection's; callers don't pass any.
    for (const selector of [{ warehouse: "EXPLICIT" }, { role: "READER" }, { schema: "S" }])
      expect(() => fromToml(selector as never)).toThrow(thrown("INVALID_OPTIONS"));
  });

  it("rejects discarded region configuration with a clear alternative", async () => {
    expect(() => normalize({ region: "eu-west-1" })).toThrow(/region-qualified account/);
    expect(() => endpoint({ ...target, region: "eu-west-1" })).toThrow(/region-qualified account/);
    await configFile('[default]\naccount="locator"\nregion="eu-west-1"');
    expect(() => profileFields({})).toThrow(thrown("CONFIG_INVALID"));
    expect(() => fromToml()).toThrow(thrown("CONFIG_INVALID"));
    expect(endpoint({ account: "locator.eu-west-1" })).toBe(
      "https://locator.eu-west-1.snowflakecomputing.com",
    );
  });

  it("preserves a profile's custom endpoint port for driver authentication", async () => {
    await configFile(
      '[default]\naccount="org-account"\nhost="custom.invalid"\nport=8443\nauthenticator="externalbrowser"',
    );
    const options = fromToml({ name: "default" });
    expect(options).toMatchObject({
      account: "org-account",
      authenticator: "externalbrowser",
      accessUrl: "https://custom.invalid:8443",
    });
    const provider = createConnectionOptions(options);
    expect(provider.getOwnerOptions()).toMatchObject({
      authenticator: "externalbrowser",
      accessUrl: "https://custom.invalid:8443",
    });
    // A browser login has no token to extend with the caller's.
    expect(() => provider.getCallerOptions("alice")).toThrow(thrown("AUTH_NOT_SUPPORTED"));
  });
});

describe("caller absence versus invalid presence", () => {
  it.each([null, undefined])("returns null only for absent headers (%s)", (token) => {
    expect(getCallerUserToken({ get: () => token })).toBeNull();
  });
  it.each(["", " ", "\t\r\n", 42])("rejects a present invalid header (%j)", (token) => {
    expect(() => getCallerUserToken({ get: () => token as string })).toThrow(
      thrown("CALLER_CONTEXT_REQUIRED"),
    );
  });
  it("preserves an opaque nonempty header", () => {
    expect(getCallerUserToken({ get: () => " opaque.synthetic " })).toBe(" opaque.synthetic ");
  });
  it("rejects a blank caller before reading credentials", () => {
    const { options, read } = countingConnection();
    for (const callerAsOwner of [false, true]) {
      const provider = createConnectionOptions(options, { callerAsOwner });
      expect(() => provider.getCallerOptions(" ")).toThrow(thrown("CALLER_CONTEXT_REQUIRED"));
      expect(() => optionsScope(provider, { token: " " })).toThrow(
        thrown("CALLER_CONTEXT_REQUIRED"),
      );
      expect(() => optionsScope(provider, { headers: { get: () => " " } })).toThrow(
        thrown("CALLER_CONTEXT_REQUIRED"),
      );
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("has no absent-header fallback unless callerAsOwner is set", () => {
    const absent = { headers: { get: () => null } };
    const strict = createConnectionOptions(connection());
    expect(() => optionsScope(strict, absent)).toThrow(
      expect.objectContaining({
        code: "CALLER_CONTEXT_REQUIRED",
        details: expect.objectContaining({ nextStep: expect.stringContaining("callerAsOwner") }),
      }),
    );
    const owner = createConnectionOptions(connection(), { callerAsOwner: true });
    expect(optionsScope(owner, absent)).toMatchObject({ mode: "owner", contextKey: undefined });
    expect(optionsScope(owner, absent).options()).toEqual(owner.getOwnerOptions());
  });
});

describe("input and hook snapshots", () => {
  it("snapshots the connection options and factory options at creation", () => {
    const input = { ...connection(), warehouse: "ORIGINAL" };
    const factoryOptions = { callerAsOwner: false };
    const provider = createConnectionOptions(input, factoryOptions);
    input.warehouse = "CHANGED";
    input.token = "changed";
    input.account = "other";
    factoryOptions.callerAsOwner = true;
    expect(provider.getOwnerOptions()).toMatchObject({
      account: "org-account",
      warehouse: "ORIGINAL",
      token: "synthetic-token",
    });
    expect(provider.getCallerOptions("alice").token).toBe("synthetic-token.alice");
    expect(optionsScope(provider, { token: "alice" }).mode).toBe("caller");
    // The provider itself can't be changed to run callers as the owner.
    expect(Object.isFrozen(provider)).toBe(true);
    expect(() => {
      (provider as { getCallerOptions: unknown }).getCallerOptions = () => connection();
    }).toThrow(TypeError);
  });

  it("returns copies of the options, so a caller can't change the next result", () => {
    const provider = createConnectionOptions(connection());
    const owner = provider.getOwnerOptions();
    const caller = provider.getCallerOptions("alice");
    owner.token = "mutated-return";
    caller.token = "mutated-return";
    expect(provider.getOwnerOptions().token).toBe("synthetic-token");
    expect(provider.getCallerOptions("alice").token).toBe("synthetic-token.alice");
  });

  it("snapshots selector input and the selected profile when fromToml returns", async () => {
    await configFile(
      '[dev]\naccount="org-account"\nwarehouse="ORIGINAL"\nauthenticator="oauth"\ntoken="synthetic"\n[other]\naccount="other-account"',
    );
    const selectors = { name: "dev", configFile: path.join(directory, "connections.toml") };
    const options = fromToml(selectors);
    selectors.name = "other";
    selectors.configFile = path.join(directory, "missing.toml");
    await configFile('[dev]\naccount="changed-account"\nwarehouse="CHANGED"');
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEV_ACCOUNT", "another-account");
    expect(options).toEqual({
      account: "org-account",
      warehouse: "ORIGINAL",
      authenticator: "oauth",
      token: "synthetic",
      accessUrl: "https://org-account.snowflakecomputing.com",
    });
    expect(createConnectionOptions(options).getOwnerOptions()).toMatchObject({
      account: "org-account",
      warehouse: "ORIGINAL",
    });
  });

  it("selects the token file when fromToml returns, then rereads only that file", async () => {
    const filename = path.join(directory, "token");
    await writeFile(filename, "original", { mode: 0o600 });
    await configFile(
      '[default]\naccount="org-account"\nauthenticator="oauth"\ntoken_file_path="token"',
    );
    const options = createConnectionOptions(fromToml());
    // Changing the profile afterwards doesn't change which file is read.
    await configFile(
      '[default]\naccount="org-account"\nauthenticator="oauth"\ntoken_file_path="missing"',
    );
    vi.mocked(readFileSync).mockClear();
    expect(options.getOwnerOptions().token).toBe("original");
    await writeFile(filename, "rotated", { mode: 0o600 });
    expect(options.getOwnerOptions().token).toBe("rotated");
    expect(options.getCallerOptions("alice").token).toBe("rotated.alice");
    const reads = vi.mocked(readFileSync).mock.calls.map(([readPath]) => readPath);
    expect(reads).toHaveLength(3);
    expect(reads.every((readPath) => readPath === filename)).toBe(true);
  });

  it("snapshots structural provider methods while preserving class and private-field this", () => {
    class Provider implements ConnectionOptionsProvider {
      #token = "original";
      rotate() {
        this.#token = "rotated";
      }
      getOwnerOptions() {
        return { ...connection(), token: this.#token };
      }
      getCallerOptions(token: string) {
        return { ...connection(), token: `${this.#token}.${token}` };
      }
    }
    const custom = new Provider();
    const provider = snapshotProvider(custom);
    custom.getOwnerOptions = () => {
      throw new Error("changed hook");
    };
    custom.getCallerOptions = () => {
      throw new Error("changed hook");
    };
    expect(optionsScope(provider).options().token).toBe("original");
    expect(optionsScope(provider, { token: "alice" }).options().token).toBe("original.alice");
    custom.rotate();
    expect(optionsScope(provider).options().token).toBe("rotated");
    expect(optionsScope(provider, { token: "alice" }).options().token).toBe("rotated.alice");
    expect(Object.isFrozen(provider)).toBe(true);
  });
});

describe("native options contracts", () => {
  it.each([{}, [null], { getOwnerOptions: () => connection() }, new Array(1)])(
    "rejects malformed providers: %o",
    (provider) => {
      expect(() => snapshotProvider(provider as never)).toThrow(thrown("INVALID_OPTIONS"));
    },
  );

  it.each([null, undefined, false, 0, "", [], "options", 42])(
    "rejects malformed option returns: %o",
    (invalid) => {
      const get = () => invalid as never;
      expect(() => optionsScope({ getOwnerOptions: get, getCallerOptions: get }).options()).toThrow(
        thrown("AUTH_FAILED"),
      );
      expect(() =>
        optionsScope({ getOwnerOptions: get, getCallerOptions: get }, { token: "alice" }).options(),
      ).toThrow(thrown("AUTH_FAILED"));
    },
  );

  it.each([{}, { target }, { authenticator: "OAUTH", token: "synthetic" }])(
    "rejects option returns that identify no endpoint: %o",
    (invalid) => {
      const get = () => invalid as never;
      expect(() => optionsScope({ getOwnerOptions: get, getCallerOptions: get }).options()).toThrow(
        thrown("CONFIG_INVALID"),
      );
    },
  );

  it.each([
    { authenticator: 1 },
    { authenticator: [] },
    { authenticator: null },
    { sessionToken: "not-supported" },
    { masterToken: "not-supported" },
    { session_token: "not-supported" },
    { master_token: "not-supported" },
  ])("rejects unsupported credential fields in option returns: %o", (fields) => {
    const get = () => ({ ...connection(), ...fields }) as never;
    const provider = { getOwnerOptions: get, getCallerOptions: get };
    for (const context of [undefined, { token: "alice" }])
      expect(() => optionsScope(provider, context).options()).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^AUTH_(FAILED|NOT_SUPPORTED)$/) }),
      );
  });

  it.each([
    { account: "org-account", authenticator: "OAUTH", token: "synthetic" },
    { account: "org-account", authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token: "synthetic" },
    { account: "org-account", username: "user", password: "synthetic" },
    { account: "org-account", username: "user", privateKey: "synthetic" },
    {
      account: "org-account",
      username: "user",
      privateKeyPath: "synthetic-path",
      privateKeyPass: "",
    },
    { account: "org-account", authenticator: "EXTERNALBROWSER" },
    {
      account: "org-account",
      authenticator: "OAUTH_CLIENT_CREDENTIALS",
      oauthClientId: "client",
      oauthClientSecret: "synthetic",
    },
  ] as snowflake.ConnectionOptions[])(
    "passes native credentials through unchanged for owner views: %o",
    (fields) => {
      const provider = createConnectionOptions(fields, { callerAsOwner: true });
      const expected = { ...fields, accessUrl: "https://org-account.snowflakecomputing.com" };
      expect(provider.getOwnerOptions()).toMatchObject(expected);
      expect(provider.getCallerOptions("alice")).toEqual(provider.getOwnerOptions());
      expect(optionsScope(provider, { token: "alice" }).options()).toMatchObject(expected);
    },
  );

  it.each([
    { account: "org-account", username: "user", password: "synthetic" },
    { account: "org-account", authenticator: "EXTERNALBROWSER" },
    { account: "org-account", username: "user", privateKey: "synthetic" },
  ] as snowflake.ConnectionOptions[])(
    "refuses to run a caller on credentials with no token to extend: %o",
    (fields) => {
      const provider = createConnectionOptions(fields);
      expect(provider.getOwnerOptions()).toMatchObject(fields);
      expect(() => provider.getCallerOptions("alice")).toThrow(thrown("AUTH_NOT_SUPPORTED"));
      expect(() => optionsScope(provider, { token: "alice" }).options()).toThrow(
        thrown("AUTH_NOT_SUPPORTED"),
      );
    },
  );
});
