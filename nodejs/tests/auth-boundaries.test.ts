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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthManager,
  credentialOptions,
  defaultProviders,
  fromCredentials,
  fromTokenFile,
  getCallerUserToken,
  type AuthProvider,
  type Credential,
  type CredentialSource,
} from "../src/auth-manager.js";
import {
  bindTarget,
  endpoint,
  mergeFields,
  mounts,
  normalize,
  profileFields,
  type Fields,
} from "../src/config.js";
import type { ConnectionOptions } from "../src/types.js";

// Keep every file/configuration probe synthetic, including platform detection.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async (filename: string) => {
      if (Object.values(mounts).includes(filename))
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return actual.access(filename);
    }),
    readFile: vi.fn(actual.readFile),
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-auth-boundaries-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
  vi.stubEnv("CI", "true");
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const target = { account: "org-account" };
const oauth: Credential = { type: "oauth", token: "synthetic-token" };
function managerFor(credential: unknown, boundTarget: ConnectionOptions = target) {
  const fallback = vi.fn();
  const manager = new AuthManager({
    environment: "local",
    auth: {
      providers: [
        {
          id: "test",
          async resolve() {
            return {
              target: boundTarget,
              async acquire() {
                return credential as Credential;
              },
            };
          },
        },
        { id: "fallback", resolve: fallback },
      ],
    },
  });
  return { manager, fallback };
}
const configFile = (text: string) =>
  writeFile(path.join(directory, "connections.toml"), text, { mode: 0o600 });

describe("effective target boundaries", () => {
  it("validates the merged target rather than requiring an endpoint on the partial provider target", async () => {
    const manager = new AuthManager({
      connection: { ...target, warehouse: "APP" },
      auth: {
        providers: [
          {
            id: "partial",
            async resolve() {
              return {
                target: { role: "READER" },
                async acquire() {
                  return oauth;
                },
              };
            },
          },
        ],
      },
    });
    expect((await manager.source()).target).toEqual({
      ...target,
      accessUrl: "https://org-account.snowflakecomputing.com",
      warehouse: "APP",
      role: "READER",
    });
  });

  it.each([
    "token",
    "password",
    "authenticator",
    "sessionToken",
    "clientStoreTemporaryCredential",
    "name",
    "configFile",
    "region",
  ])("rejects %s in provider targets before acquisition", async (key) => {
    const acquire = vi.fn(async () => oauth);
    const fallback = vi.fn();
    const manager = new AuthManager({
      auth: {
        providers: [
          {
            id: "invalid",
            async resolve() {
              return { target: { ...target, [key]: "not-a-target-field" }, acquire };
            },
          },
          { id: "fallback", resolve: fallback },
        ],
      },
    });
    await expect(manager.source()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(acquire).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([null, [], { account: 42 }, { account: " " }])(
    "rejects invalid target shapes/types: %o",
    async (invalid) => {
      await expect(
        managerFor(oauth, invalid as ConnectionOptions).manager.source(),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    },
  );

  it("rejects conflicting host/accessUrl on the final target", async () => {
    const manager = new AuthManager({
      connection: { host: "other.invalid" },
      auth: {
        providers: [
          fromCredentials({ target: { accessUrl: "https://account.invalid" }, credential: oauth }),
        ],
      },
    });
    await expect(manager.source()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects invalid effective endpoints before acquiring credentials", async () => {
    const acquire = vi.fn(async () => oauth);
    const manager = new AuthManager({
      connection: { accessUrl: "http://account.invalid" },
      auth: {
        providers: [
          {
            id: "partial",
            async resolve() {
              return { target: {}, acquire };
            },
          },
        ],
      },
    });
    await expect(manager.source()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("permits custom endpoints paired with the same account and SQL context overlays", async () => {
    const custom = {
      ...target,
      host: "private.account.invalid:8443",
      accessUrl: "https://private.account.invalid:8443/",
    };
    const manager = new AuthManager({
      connection: { ...target, warehouse: "APP", role: "READER" },
      auth: { providers: [fromCredentials({ target: custom, credential: oauth })] },
    });
    expect((await manager.source()).target).toMatchObject({
      ...custom,
      accessUrl: "https://private.account.invalid:8443",
      warehouse: "APP",
      role: "READER",
    });
    expect(endpoint(bindTarget(target, custom))).toBe("https://private.account.invalid:8443");
  });

  it("accepts equivalent origins without imposing the account's derived hostname", () => {
    expect(
      endpoint({ ...target, host: "CUSTOM.invalid:443", accessUrl: "https://custom.invalid/" }),
    ).toBe("https://custom.invalid");
    expect(
      endpoint(
        mergeFields({ host: "CUSTOM.invalid:443" }, { accessUrl: "https://custom.invalid/" }),
      ),
    ).toBe("https://custom.invalid");
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
    expect(() => endpoint(fields)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("configuration source merging", () => {
  it.each([
    [{ account: "first", token: "synthetic" }, { account: "second" }],
    [{ username: "first", password: "synthetic" }, { username: "second" }],
    [{ account: "first", authenticator: "externalbrowser" }, { account: "second" }],
    [{ host: "first.invalid" }, { accessUrl: "https://second.invalid" }],
    [{ account: "first", token: "synthetic" }, { host: "second.invalid" }],
    [{ host: "first.invalid", token: "synthetic" }, { account: "second" }],
    [
      { account: "first", host: "first.invalid" },
      { account: "first", accessUrl: "https://second.invalid" },
    ],
    [{ host: "first.invalid", port: 443 }, { port: 8443 }],
    [{ host: "first.invalid" }, { accessUrl: "https://first.invalid:8443" }],
  ] as [Fields, Fields][])(
    "rejects conflicting cross-source identities/endpoints",
    (base, overlay) => {
      expect(() => mergeFields(base, overlay)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    },
  );

  it("keeps same-identity SQL overlays and removes credentials on an authenticator change", () => {
    const base = {
      account: "org-account",
      username: "user",
      authenticator: "OAUTH",
      token: "synthetic",
      warehouse: "BASE",
      schema: "BASE_SCHEMA",
    };
    expect(
      mergeFields(base, {
        account: "ORG-ACCOUNT",
        username: "USER",
        warehouse: "APP",
        role: "READER",
      }),
    ).toMatchObject({
      token: "synthetic",
      warehouse: "APP",
      schema: "BASE_SCHEMA",
      role: "READER",
    });
    expect(mergeFields(base, { authenticator: "EXTERNALBROWSER" })).not.toHaveProperty("token");
    expect(
      mergeFields({ username: "generic" }, { username: "profile", password: "synthetic" }),
    ).toMatchObject({ username: "profile" });
  });

  it("does not inherit generic credentials into a different profile identity", async () => {
    await configFile(
      '[default]\naccount="profile-account"\nuser="profile-user"\nauthenticator="oauth"',
    );
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "generic-account");
    vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
    vi.stubEnv("SNOWFLAKE_TOKEN", "synthetic");
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not retarget profile credentials through named environment overrides", async () => {
    await configFile(
      '[default]\naccount="profile-account"\nuser="profile-user"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_USER", "another-user");
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("keeps same-identity named and explicit SQL context overlays", async () => {
    await configFile(
      '[default]\naccount="org-account"\nuser="profile-user"\nhost="custom.invalid"\nwarehouse="PROFILE"\nauthenticator="oauth"\ntoken="synthetic"',
    );
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_ACCOUNT", "ORG-ACCOUNT");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_WAREHOUSE", "NAMED");
    vi.stubEnv("SNOWFLAKE_SCHEMA", "GENERIC");
    expect(await profileFields({ warehouse: "EXPLICIT", role: "READER" })).toMatchObject({
      warehouse: "EXPLICIT",
      role: "READER",
      schema: "GENERIC",
      host: "custom.invalid",
      token: "synthetic",
    });
  });

  it("rejects discarded region configuration with a clear alternative", async () => {
    expect(() => normalize({ region: "eu-west-1" })).toThrow(/region-qualified account/);
    expect(() => endpoint({ ...target, region: "eu-west-1" })).toThrow(/region-qualified account/);
    await configFile('[default]\naccount="locator"\nregion="eu-west-1"');
    await expect(profileFields({})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(endpoint({ account: "locator.eu-west-1" })).toBe(
      "https://locator.eu-west-1.snowflakecomputing.com",
    );
  });

  it("preserves a profile's custom endpoint port for driver authentication", async () => {
    await configFile(
      '[default]\naccount="org-account"\nhost="custom.invalid"\nport=8443\nauthenticator="externalbrowser"',
    );
    const manager = new AuthManager({ connection: { name: "default" }, environment: "local" });
    const resolved = await manager.acquire(undefined);
    expect(resolved.credential).toMatchObject({
      type: "driver",
      options: { accessUrl: "https://custom.invalid:8443", host: "custom.invalid" },
    });
  });
});

describe("caller absence versus invalid presence", () => {
  it.each([null, undefined])("returns null only for absent headers (%s)", (token) => {
    expect(getCallerUserToken({ get: () => token })).toBeNull();
  });
  it.each(["", " ", "\t\r\n", 42])("rejects a present invalid header (%j)", (token) => {
    expect(() => getCallerUserToken({ get: () => token as string })).toThrow(
      expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
    );
  });
  it("preserves an opaque nonempty header", () => {
    expect(getCallerUserToken({ get: () => " opaque.synthetic " })).toBe(" opaque.synthetic ");
  });
  it("rejects a blank caller before source resolution, but keeps local absent-header fallback", async () => {
    const resolve = vi.fn(async () => ({
      target,
      async acquire() {
        return oauth;
      },
    }));
    const manager = new AuthManager({
      environment: "local",
      auth: { providers: [{ id: "test", resolve }] },
    });
    await expect(manager.acquire(" ")).rejects.toMatchObject({ code: "CALLER_CONTEXT_REQUIRED" });
    expect(resolve).not.toHaveBeenCalled();
    expect((await manager.acquire(null)).credential).toEqual(oauth);
  });
});

describe("input and hook snapshots", () => {
  it("snapshots explicit target, typed credentials and nested driver options", async () => {
    const options = {
      id: "explicit",
      target: { ...target },
      credential: {
        type: "driver" as const,
        options: { authenticator: "OAUTH", token: "original" },
      },
    };
    const provider = fromCredentials(options);
    options.id = "changed";
    options.target.account = "other";
    options.credential.options.token = "changed";
    options.credential = {
      type: "driver",
      options: { authenticator: "OAUTH", token: "replacement" },
    };
    expect(provider.id).toBe("explicit");
    const selected = (await provider.resolve({ connection: {} }))!;
    expect(selected.target).toEqual(target);
    const first = await selected.acquire();
    expect(first).toEqual({
      type: "driver",
      options: { authenticator: "OAUTH", token: "original" },
    });
    if (first.type === "driver") first.options.token = "mutated-return";
    expect(await selected.acquire()).toEqual({
      type: "driver",
      options: { authenticator: "OAUTH", token: "original" },
    });
  });

  it("snapshots token file helper inputs while continuing to reread the selected file", async () => {
    const filename = path.join(directory, "token");
    await writeFile(filename, "original", { mode: 0o600 });
    const options = {
      id: "file",
      path: filename,
      type: "oauth" as "oauth" | "pat",
      target: { ...target },
      optional: false,
    };
    const provider = fromTokenFile(options);
    options.id = "changed";
    options.path = path.join(directory, "missing");
    options.type = "pat";
    options.target.account = "other";
    options.optional = true;
    const selected = (await provider.resolve({ connection: {} }))!;
    expect(provider.id).toBe("file");
    expect(selected.target).toEqual(target);
    expect(await selected.acquire()).toEqual({ type: "oauth", token: "original" });
    await writeFile(filename, "rotated", { mode: 0o600 });
    expect(await selected.acquire()).toEqual({ type: "oauth", token: "rotated" });
    expect(vi.mocked(readFile).mock.calls.every(([readPath]) => readPath === filename)).toBe(true);
  });

  it("snapshots provider IDs and hooks while preserving class/private-field this and live credential rotation", async () => {
    class Provider implements AuthProvider {
      id = "original";
      #source: CredentialSource = {
        target: { ...target },
        async acquire() {
          return oauth;
        },
      };
      async resolve() {
        return this.#source;
      }
    }
    const provider = new Provider();
    const registrations: AuthProvider[] = [provider];
    const options = { connection: { warehouse: "ORIGINAL" }, auth: { providers: registrations } };
    const manager = new AuthManager(options);
    provider.id = "changed";
    provider.resolve = vi.fn(async () => {
      throw new Error("changed hook");
    });
    registrations.length = 0;
    options.connection.warehouse = "CHANGED";
    expect((await manager.source()).target.warehouse).toBe("ORIGINAL");
    expect(manager.selectedId).toBe("original");
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it("snapshots source targets and acquire functions without breaking source this", async () => {
    class Source implements CredentialSource {
      target = { ...target };
      #token = "original";
      rotate() {
        this.#token = "rotated";
      }
      async acquire(): Promise<Credential> {
        return { type: "oauth", token: this.#token };
      }
    }
    const source = new Source();
    const manager = new AuthManager({
      environment: "local",
      auth: {
        providers: [
          {
            id: "class",
            async resolve() {
              return source;
            },
          },
        ],
      },
    });
    const selected = await manager.source();
    source.target.account = "changed";
    source.acquire = vi.fn(async () => {
      throw new Error("changed hook");
    });
    expect(selected.target.account).toBe("org-account");
    expect((await manager.acquire(undefined)).credential).toEqual({
      type: "oauth",
      token: "original",
    });
    source.rotate();
    expect((await manager.acquire(undefined)).credential).toEqual({
      type: "oauth",
      token: "rotated",
    });
    expect(source.acquire).not.toHaveBeenCalled();
    expect(Object.isFrozen(selected.target)).toBe(true);
  });

  it("snapshots default-provider profile selectors before async discovery", async () => {
    await configFile('[default]\naccount="org-account"\nauthenticator="oauth"\ntoken="synthetic"');
    const options = {
      connection: { name: "default", warehouse: "ORIGINAL" },
      auth: { profileEnvironmentOverrides: false },
    };
    const providers = defaultProviders(options);
    options.connection.name = "missing";
    options.connection.warehouse = "CHANGED";
    options.auth.profileEnvironmentOverrides = true;
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEFAULT_ACCOUNT", "another-account");
    expect((await providers[0]!.resolve({ connection: {} }))!.target.warehouse).toBe("ORIGINAL");
  });
});

describe("typed provider contracts", () => {
  it.each([{}, [null], [{ id: 42, resolve: async () => undefined }], new Array(1)])(
    "rejects malformed provider registrations: %o",
    (providers) => {
      expect(() => new AuthManager({ auth: { providers: providers as AuthProvider[] } })).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS" }),
      );
    },
  );

  it.each([
    null,
    false,
    0,
    "",
    [],
    {},
    { target },
    { target, acquire: 42 },
    { target, platform: "other", acquire: async () => oauth },
  ])("rejects malformed source returns without fallback: %o", async (invalid) => {
    const fallback = vi.fn();
    const manager = new AuthManager({
      auth: {
        providers: [
          {
            id: "invalid",
            async resolve() {
              return invalid as CredentialSource;
            },
          },
          { id: "fallback", resolve: fallback },
        ],
      },
    });
    await expect(manager.source()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("allows only undefined to decline a provider", async () => {
    const manager = new AuthManager({
      auth: {
        providers: [
          {
            id: "absent",
            async resolve() {
              return undefined;
            },
          },
          fromCredentials({ target, credential: oauth }),
        ],
      },
    });
    await manager.source();
    expect(manager.selectedId).toBe("explicit");
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { type: "other" },
    { type: "oauth", token: 1 },
    { type: "pat", token: " " },
    { type: "oauth", token: "synthetic", password: "extra" },
    { type: "password", username: "user" },
    { type: "password", username: " ", password: "synthetic" },
    { type: "keypair", username: "user" },
    { type: "keypair", username: "user", privateKey: "inline", privateKeyPath: "path" },
    { type: "keypair", username: "user", privateKey: "inline", privateKeyPass: 1 },
    { type: "driver", options: null },
    { type: "driver", options: [] },
    { type: "driver", options: {} },
    { type: "driver", options: { authenticator: 1 } },
    { type: "driver", options: { authenticator: " " } },
    { type: "driver", options: { authenticator: "OAUTH" } },
    {
      type: "driver",
      options: { authenticator: "OAUTH", token: "synthetic", sessionToken: "not-supported" },
    },
    {
      type: "driver",
      options: {
        authenticator: "OAUTH",
        token: "synthetic",
        clientStoreTemporaryCredential: "false",
      },
    },
    { type: "driver", options: { authenticator: "SNOWFLAKE", username: "user" } },
    {
      type: "driver",
      options: { authenticator: "OAUTH_CLIENT_CREDENTIALS", oauthClientId: "client" },
    },
    {
      type: "driver",
      options: { authenticator: "OAUTH", token: "synthetic", password: "conflict" },
    },
  ])("rejects malformed credential returns without fallback: %o", async (invalid) => {
    const { manager, fallback } = managerFor(invalid);
    await expect(manager.acquire(undefined)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(manager.acquire(undefined)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(fallback).not.toHaveBeenCalled();
    expect(() => fromCredentials({ target, credential: invalid as Credential })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
  });

  it.each([
    { type: "oauth", token: "synthetic" },
    { type: "pat", token: "synthetic" },
    { type: "password", username: "user", password: "synthetic" },
    { type: "keypair", username: "user", privateKey: "synthetic" },
    { type: "keypair", username: "user", privateKeyPath: "synthetic-path", privateKeyPass: "" },
    {
      type: "driver",
      options: {
        authenticator: "OAUTH",
        token: "synthetic",
        clientStoreTemporaryCredential: false,
      },
    },
    {
      type: "driver",
      options: { authenticator: "PROGRAMMATIC_ACCESS_TOKEN", password: "synthetic" },
    },
    { type: "driver", options: { username: "user", password: "synthetic" } },
    {
      type: "driver",
      options: {
        authenticator: "OAUTH_CLIENT_CREDENTIALS",
        oauthClientId: "client",
        oauthClientSecret: "synthetic",
      },
    },
  ] as Credential[])("accepts valid typed credentials: %o", async (credential) => {
    expect((await managerFor(credential).manager.acquire(undefined)).credential).toEqual(
      credential,
    );
  });

  it.each([
    { type: "password", username: "other", password: "synthetic" },
    { type: "driver", options: { authenticator: "OAUTH", token: "synthetic", account: "other" } },
    {
      type: "driver",
      options: { authenticator: "OAUTH", token: "synthetic", host: "other.invalid" },
    },
  ])("rejects credential identity/endpoint conflicts with the bound target", async (credential) => {
    await expect(
      managerFor(credential, { ...target, username: "user" }).manager.acquire(undefined),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("validates and copies driver options before applying interactive policy", () => {
    const detected = { environment: "local" as const, platform: "unknown" as const, evidence: [] };
    expect(() =>
      credentialOptions(
        { type: "driver", options: { authenticator: "EXTERNALBROWSER" } },
        detected,
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "AUTH_INTERACTION_REQUIRED" }));
    const credential: Credential = {
      type: "driver",
      options: { authenticator: "OAUTH", token: "synthetic" },
    };
    const options = credentialOptions(credential, detected, {});
    options.token = "changed";
    expect(credential.options.token).toBe("synthetic");
  });

  it("permits a driver username supplied by the final target", async () => {
    const credential: Credential = { type: "driver", options: { password: "synthetic" } };
    expect(
      (await managerFor(credential, { ...target, username: "user" }).manager.acquire(undefined))
        .credential,
    ).toEqual(credential);
    await expect(managerFor(credential).manager.acquire(undefined)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("canonicalizes equivalent driver access URLs before the client's duplicate target check", async () => {
    const credential: Credential = {
      type: "driver",
      options: {
        authenticator: "OAUTH",
        token: "synthetic",
        accessUrl: "https://custom.invalid:443/",
      },
    };
    const resolved = await managerFor(credential, {
      ...target,
      accessUrl: "https://custom.invalid/",
    }).manager.acquire(undefined);
    expect(credentialOptions(resolved.credential, resolved.detected, {}).accessUrl).toBe(
      resolved.source.target.accessUrl,
    );
  });
});
