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
  fromToml,
  type ConnectionOptionsFactory,
  type ConnectionOptionsFactoryOptions,
} from "../src/auth.js";
import { createSarClient } from "../src/index.js";
import { nextSteps, SarError } from "../src/errors.js";
import { fakeDriver } from "./fake-driver.js";
import type { QueryReference, SarClientOptions } from "../src/types.js";

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
vi.mock("../src/auth-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth-client.js")>();
  return { ...actual, createConnectionOptions: vi.fn(actual.createConnectionOptions) };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-client-options-"));
  mountedFiles.clear();
  vi.clearAllMocks();
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
  // Without platform evidence or an explicit environment, CI keeps detection at "unknown".
  vi.stubEnv("CI", "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const profiles = () =>
  writeFile(
    path.join(directory, "connections.toml"),
    [
      '[default]\naccount="default-account"\nauthenticator="oauth"\ntoken="default-token"',
      '[dev]\naccount="dev-account"\nauthenticator="oauth"\ntoken="dev-token"',
      '[sso]\naccount="sso-account"\nuser="developer"\nauthenticator="externalbrowser"',
    ].join("\n"),
    { mode: 0o600 },
  );
const owned = () =>
  vi.mocked(createConnectionOptions).mock.results.at(-1)?.value as ConnectionOptionsFactory;
const missingCaller = { headers: new Headers() };
const reference: QueryReference = {
  version: 1,
  queryId: "01b2c3d4-0000-4000-8000-000000000001",
  submittedAt: "2026-01-01T00:00:00.000Z",
  identity: { organization: "ORG", account: "ACCOUNT", user: "USER", role: "ROLE" },
  mode: "owner",
  results: { format: "json", rowMode: "object", maxRows: 10, maxBytes: 1024 },
};

describe("connection settings on createSarClient", () => {
  it("selects a SnowCLI profile and default SQL context for the owned factory", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "dev", warehouse: "APP_WH", role: "APP_ROLE" },
    });
    try {
      expect((await client.diagnostics()).connectionName).toBe("dev");
      await client.connect();
      expect(fake.connections[0]?.config).toMatchObject({
        account: "dev-account",
        token: "dev-token",
        warehouse: "APP_WH",
        role: "APP_ROLE",
      });
    } finally {
      await client.close();
    }
  });
  it("passes environment and platform to the owned factory", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "dev" },
      environment: "local",
      platform: "spcs",
    });
    try {
      expect(await client.diagnostics()).toMatchObject({ environment: "local", platform: "spcs" });
      await client.asCaller({ token: "alice" }).query("SELECT 1");
      expect(fake.connections[0]?.config.token).toBe("dev-token.alice");
    } finally {
      await client.close();
    }
  });
  it("applies the interactive policy and driver options to owned logins", async () => {
    vi.stubEnv("CI", undefined);
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "sso" },
      environment: "local",
      interactive: "always",
      driverOptions: { clientStoreTemporaryCredential: true },
    });
    const strict = createSarClient({
      driver: fake.driver,
      connection: { name: "sso" },
      environment: "local",
      interactive: "never",
    });
    try {
      await client.connect();
      expect(fake.connections[0]?.config).toMatchObject({
        authenticator: "EXTERNALBROWSER",
        username: "developer",
        clientStoreTemporaryCredential: true,
      });
      await expect(strict.connect()).rejects.toMatchObject({
        code: "AUTH_INTERACTION_REQUIRED",
        details: { nextStep: nextSteps.interaction },
      });
      expect(fake.connections).toHaveLength(1);
    } finally {
      await Promise.all([client.close(), strict.close()]);
    }
  });
  it("applies callerFallback and reports fallback to the logger", async () => {
    await profiles();
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "dev" },
      environment: "local",
      logger,
    });
    const strict = createSarClient({
      driver: fake.driver,
      connection: { name: "dev" },
      environment: "local",
      callerFallback: "error",
    });
    try {
      await client.asCaller(missingCaller).query("SELECT 1");
      expect(fake.connections[0]?.config.token).toBe("dev-token");
      expect(logger.mock.calls).toEqual([
        [{ event: "caller-fallback", environment: "local" }],
        [{ event: "session-opened", mode: "caller", durationMs: expect.any(Number) }],
        [
          {
            event: "query-succeeded",
            queryId: "query-1",
            durationMs: expect.any(Number),
            rowCount: 1,
          },
        ],
      ]);
      const error = await strict
        .asCaller(missingCaller)
        .query("SELECT 1")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        message: 'Caller context is required because callerFallback is "error"',
        details: { nextStep: nextSteps.ingress },
      });
      expect(fake.connections).toHaveLength(1);
    } finally {
      await Promise.all([client.close(), strict.close()]);
    }
  });
  it("passes timeouts.authMs to the owned factory and closes it with the client", async () => {
    const logger = vi.fn();
    const client = createSarClient({
      connection: { name: "dev" },
      callerFallback: "error",
      callerAsOwner: true,
      logger,
      timeouts: { authMs: 5_000 },
    });
    expect(createConnectionOptions).toHaveBeenCalledExactlyOnceWith(undefined, {
      connection: { name: "dev" },
      environment: undefined,
      platform: undefined,
      interactive: undefined,
      callerFallback: "error",
      callerAsOwner: true,
      authTimeoutMs: 5_000,
      driverOptions: {},
      logger,
    });
    const factory = owned();
    await client.close();
    await expect(factory.getOwnerOptions()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("borrows a supplied provider without creating or closing an owned factory", async () => {
    const supplied = createConnectionOptions(
      fromCredentials({ target: { account: "test" }, credential: { type: "oauth", token: "t" } }),
    );
    const client = createSarClient({ connectionOptions: supplied, timeouts: { authMs: 5_000 } });
    expect(createConnectionOptions).toHaveBeenCalledOnce();
    await client.close();
    expect((await supplied.getOwnerOptions()).token).toBe("t");
    await supplied.close();
  });
  it.each([
    ["connection", { name: "dev" }],
    ["environment", "local"],
    ["platform", "spcs"],
    ["interactive", "always"],
    ["callerFallback", "error"],
    ["driverOptions", { clientStoreTemporaryCredential: true }],
    ["logger", () => {}],
  ] as const)("rejects %s alongside connectionOptions", (key, value) => {
    const supplied = createConnectionOptions([]);
    expect(() =>
      createSarClient({ connectionOptions: supplied, [key]: value } as SarClientOptions),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: `${key} cannot be combined with connectionOptions; configure the supplied provider instead`,
      }),
    );
    expect(createConnectionOptions).toHaveBeenCalledOnce();
    const client = createSarClient({
      connectionOptions: supplied,
      [key]: undefined,
    } as SarClientOptions);
    expect(createConnectionOptions).toHaveBeenCalledOnce();
    return client.close();
  });
  it.each([
    [{ connection: { password: "synthetic" } }, "Unknown connection option: password"],
    [{ connection: { name: " " } }, "name must be a nonempty string"],
    [{ environment: "staging" }, "Invalid environment"],
    [{ platform: "other" }, "Invalid platform"],
    [{ interactive: "yes" }, "Invalid interactive"],
    [{ callerFallback: "sometimes" }, "Invalid callerFallback"],
    [{ driverOptions: { token: "synthetic" } }, "Unknown driverOptions option: token"],
    [{ driverOptions: { proxyPort: 0 } }, "Invalid proxyPort"],
    [{ logger: "console" }, "logger must be a function"],
    [{ authTimeoutMs: 1_000 }, "Unknown client option: authTimeoutMs"],
  ])("validates connection settings at runtime: %o", (settings, message) => {
    expect(() => createSarClient(settings as unknown as SarClientOptions)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", message }),
    );
    expect(createConnectionOptions).not.toHaveBeenCalled();
  });
});

describe("callerFallback and callerAsOwner", () => {
  it.each([
    ["unknown", {}],
    ["local", { CI: undefined, NODE_ENV: "development", npm_lifecycle_event: "dev" }],
  ] as const)(
    "runs caller views as the owner under callerAsOwner without platform evidence (%s)",
    async (environment, variables) => {
      for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
      await profiles();
      const fake = fakeDriver();
      const logger = vi.fn();
      const client = createSarClient({
        driver: fake.driver,
        connection: { name: "dev" },
        callerAsOwner: true,
        logger,
      });
      try {
        expect((await client.diagnostics()).environment).toBe(environment);
        await client.asCaller(missingCaller).query("SELECT 1");
        await client.asCaller({ headers: new Headers() }).withConnection(async () => {});
        await client.asCaller({ token: "alice" }).query("SELECT 2");
        expect(fake.connections.map((connection) => connection.config.token)).toEqual([
          "dev-token",
          "dev-token",
          "dev-token",
        ]);
        for (const connection of fake.connections)
          expect(connection.destroy).toHaveBeenCalledOnce();
        expect(logger.mock.calls).toEqual([
          [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
          [
            {
              event: "query-succeeded",
              queryId: "query-1",
              durationMs: expect.any(Number),
              rowCount: 1,
            },
          ],
          [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
          [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
          [
            {
              event: "query-succeeded",
              queryId: "query-3",
              durationMs: expect.any(Number),
              rowCount: 1,
            },
          ],
        ]);
      } finally {
        await client.close();
      }
    },
  );
  it("falls back with preview evidence under auto", async () => {
    mountedFiles.set("/snowflake/secrets/snowflake-session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_PREVIEW_ORIGIN", "https://preview.invalid");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({ driver: fake.driver, callerFallback: "auto", logger });
    try {
      expect((await client.diagnostics()).environment).toBe("preview");
      await client.asCaller(missingCaller).query("SELECT 1");
      expect(fake.connections[0]?.config.token).toBe("service-token");
      expect(logger.mock.calls).toEqual([
        [{ event: "caller-fallback", environment: "preview" }],
        [{ event: "session-opened", mode: "caller", durationMs: expect.any(Number) }],
        [
          {
            event: "query-succeeded",
            queryId: "query-1",
            durationMs: expect.any(Number),
            rowCount: 1,
          },
        ],
      ]);
    } finally {
      await client.close();
    }
  });
  it("runs a present preview caller token as the owner under callerAsOwner", async () => {
    mountedFiles.set("/snowflake/secrets/snowflake-session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_PREVIEW_ORIGIN", "https://preview.invalid");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({ driver: fake.driver });
    const owner = createSarClient({ driver: fake.driver, callerAsOwner: true, logger });
    const headers = new Headers({ "sf-context-current-user-token": "preview-user" });
    try {
      expect((await owner.diagnostics()).environment).toBe("preview");
      await client.asCaller({ headers }).query("SELECT 1");
      await owner.asCaller({ headers }).query("SELECT 2");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "preview-user",
        "service-token",
      ]);
      expect(logger.mock.calls).toEqual([
        [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
        [
          {
            event: "query-succeeded",
            queryId: expect.any(String),
            durationMs: expect.any(Number),
            rowCount: 1,
          },
        ],
      ]);
    } finally {
      await Promise.all([client.close(), owner.close()]);
    }
  });
  it("refuses missing callers with deployed evidence unless callerAsOwner is set", async () => {
    mountedFiles.set("/snowflake/session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const client = createSarClient({ driver: fake.driver, callerAsOwner: false });
    const owner = createSarClient({ driver: fake.driver, callerAsOwner: true });
    try {
      expect((await client.diagnostics()).environment).toBe("deployed");
      const error = await client
        .asCaller(missingCaller)
        .query("SELECT 1")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        message: "Caller context is required outside recognized local/preview execution",
        details: { nextStep: nextSteps.ingress },
      });
      expect(fake.connections).toHaveLength(0);
      await client.query("SELECT 1");
      await owner.asCaller(missingCaller).query("SELECT 2");
      await owner.asCaller({ token: "alice" }).query("SELECT 3");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "service-token",
        "service-token",
        "service-token",
      ]);
    } finally {
      await Promise.all([client.close(), owner.close()]);
    }
  });
  it("keeps requiring present caller context for detached caller methods without callerAsOwner", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "dev" },
      environment: "local",
      callerAsOwner: false,
    });
    const caller = client.asCaller(missingCaller);
    try {
      for (const operation of [
        () => caller.submitDetached("SELECT 1"),
        () => caller.pollQuery({ ...reference, mode: "caller" }),
      ])
        await expect(operation()).rejects.toMatchObject({
          code: "CALLER_CONTEXT_REQUIRED",
          message: "Detached queries require caller credentials even locally",
          details: { nextStep: nextSteps.ingress },
        });
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
  const policyOptions = (
    environment: "local" | "preview" | "unknown" | "deployed",
    settings: Pick<ConnectionOptionsFactoryOptions, "callerFallback" | "callerAsOwner">,
  ) =>
    createConnectionOptions(
      fromCredentials({
        target: { account: "test" },
        credential: { type: "oauth", token: "owner" },
      }),
      { ...settings, environment: environment === "unknown" ? undefined : environment },
    );
  it.each([
    ["local", { callerFallback: "auto" }],
    ["local", { callerFallback: "error", callerAsOwner: true }],
    ["preview", { callerFallback: "auto" }],
    ["preview", { callerFallback: "error", callerAsOwner: true }],
    ["unknown", { callerFallback: "auto", callerAsOwner: true }],
    ["deployed", { callerFallback: "auto", callerAsOwner: true }],
  ] as const)(
    "uses owner options for missing caller context in %s execution under %j",
    async (environment, settings) => {
      const options = policyOptions(environment, settings);
      try {
        expect((await options.diagnostics()).environment).toBe(environment);
        expect((await options.getCallerOptions(missingCaller)).token).toBe("owner");
      } finally {
        await options.close();
      }
    },
  );
  it.each([
    ["local", { callerFallback: "error" }, "ingress"],
    ["preview", { callerFallback: "error" }, "ingress"],
    ["unknown", { callerFallback: "auto" }, "callerFallback"],
    ["unknown", { callerFallback: "auto", callerAsOwner: false }, "callerFallback"],
    ["unknown", { callerFallback: "error" }, "ingress"],
    ["deployed", { callerFallback: "auto" }, "ingress"],
    ["deployed", { callerFallback: "error" }, "ingress"],
  ] as const)("refuses in %s execution under %j", async (environment, settings, hint) => {
    const refusals = {
      auto: "Caller context is required outside recognized local/preview execution",
      error: 'Caller context is required because callerFallback is "error"',
    };
    const options = policyOptions(environment, settings);
    try {
      expect((await options.diagnostics()).environment).toBe(environment);
      await expect(options.getCallerOptions(missingCaller)).rejects.toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        message: refusals[settings.callerFallback],
        details: { nextStep: nextSteps[hint] },
      });
    } finally {
      await options.close();
    }
  });
  it.each(["sometimes", "unless-deployed"])(
    "rejects the %s policy on the factory and the client",
    (callerFallback) => {
      const invalid = expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Invalid callerFallback",
      });
      expect(() =>
        createConnectionOptions([], { callerFallback: callerFallback as never }),
      ).toThrow(invalid);
      expect(() => createSarClient({ callerFallback: callerFallback as never })).toThrow(invalid);
      expect(createConnectionOptions).toHaveBeenCalledOnce();
    },
  );
});

describe("nextStep hints", () => {
  it("suggests ingress or callerAsOwner when the default policy refuses a local server", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({ driver: fake.driver, connection: { name: "dev" } });
    try {
      const error = await client
        .asCaller(missingCaller)
        .query("SELECT 1")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        message: "Caller context is required outside recognized local/preview execution",
        details: { nextStep: nextSteps.callerFallback },
      });
      expect(nextSteps.callerFallback).toContain("callerAsOwner: true");
      expect(nextSteps.callerFallback).not.toContain("unless-deployed");
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        nextStep: nextSteps.callerFallback,
      });
      expect(JSON.stringify(error)).not.toContain(directory);
    } finally {
      await client.close();
    }
  });
  it("suggests only ingress when deployed under the default policy", async () => {
    const client = createSarClient({ driver: fakeDriver().driver, environment: "deployed" });
    try {
      await expect(client.asCaller(missingCaller).query("SELECT 1")).rejects.toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        details: { nextStep: nextSteps.ingress },
      });
    } finally {
      await client.close();
    }
  });
  it.each([
    ["an unrecognized environment", {}],
    ["deployed execution", { environment: "deployed" }],
  ] as const)("suggests a non-interactive credential in %s", async (_label, settings) => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connection: { name: "sso" },
      interactive: "always",
      ...settings,
    });
    try {
      await expect(client.connect()).rejects.toMatchObject({
        code: "AUTH_INTERACTION_REQUIRED",
        details: { nextStep: nextSteps.nonInteractive },
      });
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
  it("points to SnowCLI discovery when no credentials are found", async () => {
    const client = createSarClient({ driver: fakeDriver().driver });
    const custom = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: createConnectionOptions([]),
    });
    try {
      const error = await client.connect().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "AUTH_NOT_FOUND",
        details: { nextStep: nextSteps.discovery },
      });
      expect(JSON.stringify(error)).toContain("SNOWFLAKE_CONNECTION_NAME");
      expect(JSON.stringify(error)).not.toContain(directory);
      const unrelated = await custom.connect().catch((error: unknown) => error);
      expect(unrelated).toMatchObject({ code: "AUTH_NOT_FOUND" });
      expect(unrelated).not.toHaveProperty("details.nextStep");
    } finally {
      await Promise.all([client.close(), custom.close()]);
    }
  });
  it.each([
    ["the connection option", { connection: { name: "missing" } }, {}],
    ["SNOWFLAKE_CONNECTION_NAME", {}, { SNOWFLAKE_CONNECTION_NAME: "missing" }],
  ] as const)(
    "keeps the discovery hint through provider normalization when %s selects a missing profile",
    async (_label, settings, variables) => {
      for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
      await profiles();
      const client = createSarClient({ driver: fakeDriver().driver, ...settings });
      try {
        const error = await client.connect().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "CONFIG_NOT_FOUND",
          message: "Authentication provider resolution failed; the source was not changed",
          details: { nextStep: nextSteps.discovery },
        });
        expect(JSON.stringify(error)).not.toContain("missing");
      } finally {
        await client.close();
      }
    },
  );
  it("points to configFile when an explicit configuration file is absent", async () => {
    const configFile = path.join(directory, "absent.toml");
    const client = createSarClient({ driver: fakeDriver().driver, connection: { configFile } });
    const standalone = createConnectionOptions(fromToml({ configFile }));
    try {
      for (const operation of [() => client.connect(), () => standalone.getOwnerOptions()]) {
        const error = await operation().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "CONFIG_NOT_FOUND",
          details: { nextStep: nextSteps.configFile },
        });
        expect(JSON.stringify(error)).not.toContain(directory);
      }
    } finally {
      await Promise.all([client.close(), standalone.close()]);
    }
  });
  it("keeps nextStep when a detached lookup re-wraps the failure", async () => {
    const client = createSarClient({ driver: fakeDriver().driver });
    try {
      await expect(client.pollQuery(reference)).rejects.toMatchObject({
        code: "AUTH_NOT_FOUND",
        details: {
          nextStep: nextSteps.discovery,
          queryId: reference.queryId,
          completion: "unknown",
        },
      });
    } finally {
      await client.close();
    }
  });
  it("does not serialize hints that providers supply", async () => {
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: createConnectionOptions({
        id: "custom",
        async resolve() {
          throw new SarError("CONFIG_NOT_FOUND", "synthetic", { nextStep: "synthetic-hint" });
        },
      }),
    });
    try {
      const error = await client.connect().catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "CONFIG_NOT_FOUND" });
      expect(error).not.toHaveProperty("details.nextStep");
      expect(JSON.stringify(error)).not.toContain("synthetic-hint");
    } finally {
      await client.close();
    }
  });
});
