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
import os from "node:os";
import path from "node:path";
import {
  createConnectionOptions,
  fromCredentials,
  fromTokenFile,
  fromToml,
  fromEnvironment,
  fromPlatform,
} from "../src/auth.js";
import { optionsScope, snapshotProvider, providerDiagnostics } from "../src/auth-client.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import { createSarClient } from "../src/index.js";
import { createFetchClient } from "../src/account-http.js";
import { HttpTransport } from "../src/http.js";
import { fakeDriver } from "./fake-driver.js";

const mountedFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const missing = () => Object.assign(new Error("Synthetic absent mount"), { code: "ENOENT" });
  return {
    ...actual,
    access: vi.fn(async (...args: Parameters<typeof actual.access>) => {
      const filename = String(args[0]);
      if (!filename.startsWith("/snowflake/")) return actual.access(...args);
      if (!mountedFiles.has(filename)) throw missing();
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const filename = String(args[0]);
      if (!filename.startsWith("/snowflake/")) return actual.readFile(...args);
      if (!mountedFiles.has(filename)) throw missing();
      return mountedFiles.get(filename);
    }),
  };
});
beforeEach(() => {
  mountedFiles.clear();
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const oauth = () =>
  fromCredentials({
    target: { account: "test" },
    credential: { type: "oauth", token: "synthetic" },
  });

describe("native connection options", () => {
  it.each(["spcs", "serverless"] as const)(
    "discovers the %s application source and reads current mounted credentials",
    async (platform) => {
      const filename =
        platform === "serverless"
          ? "/snowflake/secrets/snowflake-session/token"
          : "/snowflake/session/token";
      mountedFiles.set(filename, "first");
      vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
      const options = createConnectionOptions(fromPlatform());
      expect((await options.getOwnerOptions()).token).toBe("first");
      expect((await options.getCallerOptions({ token: "caller" })).token).toBe(
        platform === "spcs" ? "first.caller" : "caller",
      );
      mountedFiles.set(filename, "second");
      expect((await options.getOwnerOptions()).token).toBe("second");
      await expect(options.getCallerOptions({ headers: new Headers() })).rejects.toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
      });
      expect((await options.diagnostics()).platform).toBe(platform);
      await options.close();
    },
  );
  it("recognizes preview fallback but never infers caller capability for a generic mounted-environment token", async () => {
    mountedFiles.set("/snowflake/secrets/snowflake-session/token", "placeholder");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    vi.stubEnv("SNOWFLAKE_PREVIEW_ORIGIN", "https://synthetic.invalid");
    const options = createConnectionOptions(fromPlatform());
    expect((await options.getCallerOptions({ headers: new Headers() })).token).toBe("placeholder");
    const generic = createConnectionOptions(oauth());
    await expect(generic.getCallerOptions({ token: "caller" })).rejects.toMatchObject({
      code: "AUTH_NOT_SUPPORTED",
    });
    await Promise.all([options.close(), generic.close()]);
  });
  it("selected TOML wins over platform discovery and invalid selectors do not fall through", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sar-options-"));
    try {
      const filename = path.join(directory, "connections.toml");
      await writeFile(filename, '[dev]\naccount="test"\nauthenticator="oauth"\ntoken="profile"', {
        mode: 0o600,
      });
      mountedFiles.set("/snowflake/session/token", "platform");
      const options = createConnectionOptions(undefined, {
        connection: { configFile: filename, name: "dev" },
      });
      expect((await options.getOwnerOptions()).token).toBe("profile");
      const invalid = createConnectionOptions(fromToml({ configFile: filename, name: "dev" }), {
        connection: { name: "other" },
      });
      await expect(invalid.getOwnerOptions()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await Promise.all([options.close(), invalid.close()]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    null,
    [],
    { account: "test", sessionToken: "synthetic" },
    { account: "test", masterToken: "synthetic" },
    { account: "test", authenticator: 42 },
  ])(
    "rejects malformed or inherited-session options before creating a driver: %o",
    async (value) => {
      const fake = fakeDriver();
      const get = async () => value as never;
      const manager = createConnectionManager(
        { getOwnerOptions: get, getCallerOptions: get },
        { driver: fake.driver },
      );
      await expect(manager.connect()).rejects.toHaveProperty("code");
      expect(fake.connections).toHaveLength(0);
      await manager.close();
    },
  );
  it.each(["OAUTH", "PROGRAMMATIC_ACCESS_TOKEN"])(
    "uses a structural %s provider for HTTP without SQL",
    async (authenticator) => {
      const fetch = vi
        .spyOn(HttpTransport.prototype, "fetch")
        .mockResolvedValue(new Response("ok"));
      const get = async () => ({ account: "test", authenticator, token: "synthetic" });
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
    const get = async () => ({ account: "test", ...fields });
    const http = createFetchClient({ getOwnerOptions: get, getCallerOptions: get });
    await expect(http.fetch("/api/v2/test")).rejects.toMatchObject({
      code: "AUTH_NOT_SUPPORTED_FOR_REST",
    });
    expect(fetch).not.toHaveBeenCalled();
    await http.close();
  });
  it("does not infer a profile name from unrelated process configuration", async () => {
    vi.stubEnv("SNOWFLAKE_CONNECTION_NAME", "unrelated");
    const options = createConnectionOptions(oauth());
    expect((await options.diagnostics()).connectionName).toBeUndefined();
    await options.close();
  });
  it("composes a structural provider with manager, query, and aggregate layers", async () => {
    const factory = createConnectionOptions(oauth());
    const provider = {
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
      expect((await manager.diagnostics()).environment).toBe("unknown");
    } finally {
      await queries.close();
      await manager.close();
      await client.close();
    }
    expect((await factory.getOwnerOptions()).token).toBe("synthetic");
    await factory.close();
  });
  it("returns independent mutable native snapshots without probing during diagnostics", async () => {
    const provider = oauth();
    const resolve = vi.fn(provider.resolve);
    const options = createConnectionOptions({ ...provider, resolve });
    expect((await options.diagnostics()).providers[0]?.state).toBe("unprobed");
    expect(resolve).not.toHaveBeenCalled();
    const first = await options.getOwnerOptions();
    expect(first).toMatchObject({ account: "test", authenticator: "OAUTH", token: "synthetic" });
    first.token = "changed";
    first.account = "changed";
    expect(await options.getOwnerOptions()).toMatchObject({ account: "test", token: "synthetic" });
    expect(resolve).toHaveBeenCalledOnce();
    await options.close();
    await expect(options.getOwnerOptions()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it.each(["oauth", "pat"] as const)(
    "does not infer caller protocol from a generic %s token",
    async (type) => {
      const options = createConnectionOptions(
        fromCredentials({ target: { account: "test" }, credential: { type, token: "synthetic" } }),
      );
      await expect(options.getCallerOptions({ token: "caller" })).rejects.toMatchObject({
        code: "AUTH_NOT_SUPPORTED",
      });
      await options.close();
    },
  );
  it.each(["spcs", "serverless"] as const)("uses explicit %s metadata", async (platform) => {
    const options = createConnectionOptions(
      {
        id: "platform",
        async resolve() {
          return {
            target: { account: "test" },
            platform,
            async acquire() {
              return { type: "oauth", token: "owner" };
            },
          };
        },
      },
      { environment: "deployed" },
    );
    expect((await options.getCallerOptions({ token: "caller" })).token).toBe(
      platform === "spcs" ? "owner.caller" : "caller",
    );
    await options.close();
  });
  it("rejects conflicting platform metadata", async () => {
    const options = createConnectionOptions(
      {
        id: "platform",
        async resolve() {
          return {
            target: { account: "test" },
            platform: "serverless",
            async acquire() {
              return { type: "oauth", token: "owner" };
            },
          };
        },
      },
      { platform: "spcs" },
    );
    await expect(options.getOwnerOptions()).rejects.toMatchObject({ code: "ENVIRONMENT_CONFLICT" });
  });
  it("keeps absent and blank context distinct", async () => {
    const options = createConnectionOptions(oauth(), { environment: "local" });
    expect((await options.getCallerOptions({ headers: new Headers() })).token).toBe("synthetic");
    await expect(options.getCallerOptions({ token: " " })).rejects.toMatchObject({
      code: "CALLER_CONTEXT_REQUIRED",
    });
    const strict = createConnectionOptions(oauth(), {
      environment: "local",
      callerFallback: "error",
    });
    await expect(strict.getCallerOptions({ headers: new Headers() })).rejects.toMatchObject({
      code: "CALLER_CONTEXT_REQUIRED",
    });
    await Promise.all([options.close(), strict.close()]);
  });
  it("pre-aborted getters do not select a source", async () => {
    const resolve = vi.fn();
    const options = createConnectionOptions({ id: "test", resolve });
    await expect(options.getOwnerOptions({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("close aborts a pending getter", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const options = createConnectionOptions({
      id: "test",
      async resolve() {
        await gate;
        return undefined;
      },
    });
    const rejected = expect(options.getOwnerOptions()).rejects.toMatchObject({ code: "ABORTED" });
    await options.close();
    await rejected;
    finish();
  });
  it("reads current token files and fails closed after removal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sar-options-"));
    const filename = path.join(directory, "token");
    const fallback = vi.fn();
    try {
      await writeFile(filename, "first");
      const options = createConnectionOptions([
        fromTokenFile({
          id: "file",
          path: filename,
          type: "oauth",
          platform: "spcs",
          target: { account: "test" },
        }),
        { id: "fallback", resolve: fallback },
      ]);
      expect((await options.getCallerOptions({ token: "caller" })).token).toBe("first.caller");
      await writeFile(filename, "second");
      expect((await options.getOwnerOptions()).token).toBe("second");
      await rm(filename);
      await expect(options.getOwnerOptions()).rejects.toMatchObject({ code: "AUTH_FAILED" });
      expect(fallback).not.toHaveBeenCalled();
      await options.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("composes TOML with explicit selection and environment sources", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sar-options-"));
    try {
      const filename = path.join(directory, "connections.toml");
      await writeFile(
        filename,
        '[dev]\naccount="test"\nauthenticator="oauth"\ntoken="from-profile"',
        { mode: 0o600 },
      );
      const options = createConnectionOptions(
        fromToml({ configFile: filename, name: "dev", environmentOverrides: false }),
      );
      vi.stubEnv("SNOWFLAKE_CONNECTION_NAME", "unrelated");
      expect((await options.diagnostics()).connectionName).toBe("dev");
      expect((await options.getOwnerOptions()).token).toBe("from-profile");
      vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
      vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
      vi.stubEnv("SNOWFLAKE_TOKEN", "from-env");
      const environment = createConnectionOptions(fromEnvironment());
      expect((await environment.getOwnerOptions()).token).toBe("from-env");
      await Promise.all([options.close(), environment.close()]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("validates sources and policy without probing", () => {
    expect(() => fromPlatform({ platform: "wrong" as never })).toThrow();
    expect(() => fromToml({ environmentOverrides: "yes" as never })).toThrow();
    expect(() =>
      fromTokenFile({ id: "test", path: "/synthetic", type: "pat", platform: "spcs" }),
    ).toThrow();
    expect(() => createConnectionOptions([], { interactive: "yes" as never })).toThrow();
  });
  it("snapshots structural methods and caller headers while preserving receivers", async () => {
    const custom = {
      token: "synthetic",
      async getOwnerOptions() {
        return { account: "test", token: this.token };
      },
      async getCallerOptions(context: { token?: string }) {
        return { account: "test", token: context.token };
      },
    };
    const provider = snapshotProvider(custom);
    custom.getOwnerOptions = async () => {
      throw Error("changed");
    };
    expect((await provider.getOwnerOptions()).token).toBe("synthetic");
    const get = vi.fn(() => "caller");
    const scope = optionsScope(provider, { headers: { get } });
    get.mockReturnValue("changed");
    expect((await scope.acquire()).token).toBe("caller");
    expect(get).toHaveBeenCalledOnce();
    expect(await providerDiagnostics(provider)).toMatchObject({
      environment: "unknown",
      providers: [],
    });
  });
});
