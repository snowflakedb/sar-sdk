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
import type snowflake from "snowflake-sdk";
import {
  createConnectionOptions,
  fromPlatform,
  fromToml,
  type ConnectionOptionsProvider,
} from "../src/auth.js";
import { createSarClient } from "../src/index.js";
import { nextSteps, SarError } from "../src/errors.js";
import { fakeDriver } from "./fake-driver.js";
import { deferred } from "./fake-query-service.js";
import type { QueryReference, SarClientOptions } from "../src/types.js";

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

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-client-options-"));
  mountedFiles.clear();
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
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
/** Reads the connection options only when a session opens, as a rotating source would. */
const lazily = (read: () => snowflake.ConnectionOptions): ConnectionOptionsProvider => ({
  getOwnerOptions: () => createConnectionOptions(read()).getOwnerOptions(),
  getCallerOptions: (token) => createConnectionOptions(read()).getCallerOptions(token),
});
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
  it("connects with a SnowCLI profile and default SQL context from the connection options", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        ...fromToml({ name: "dev" }),
        warehouse: "APP_WH",
        role: "APP_ROLE",
      }),
    });
    try {
      expect(Object.keys(await client.diagnostics()).sort()).toEqual([
        "activeConnections",
        "idleConnections",
        "physicalConnections",
        "queuedOperations",
        "sessionMode",
      ]);
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
  it("appends the caller's token to a profile's token or a platform's mounted token", async () => {
    await profiles();
    mountedFiles.set("/snowflake/session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const profile = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromToml({ name: "dev" })),
    });
    const platform = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform()),
    });
    try {
      await profile.asCaller({ token: "alice" }).query("SELECT 1");
      await platform.asCaller({ token: "alice" }).query("SELECT 2");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "dev-token.alice",
        "service-token.alice",
      ]);
    } finally {
      await Promise.all([profile.close(), platform.close()]);
    }
  });
  it("passes an interactive profile's authenticator and driver options to owned logins", async () => {
    await profiles();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({
        ...fromToml({ name: "sso" }),
        clientStoreTemporaryCredential: true,
      }),
    });
    try {
      await client.connect();
      expect(fake.connections[0]?.config).toMatchObject({
        authenticator: "externalbrowser",
        username: "developer",
        clientStoreTemporaryCredential: true,
      });
    } finally {
      await client.close();
    }
  });
  it("refuses missing caller context without falling back or logging the refusal", async () => {
    await profiles();
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromToml({ name: "dev" })),
      logger,
    });
    try {
      expect(() => client.asCaller(missingCaller)).toThrow(
        expect.objectContaining({
          code: "CALLER_CONTEXT_REQUIRED",
          message: "Caller context carries no caller token",
          details: { nextStep: nextSteps.callerContext },
        }),
      );
      expect(fake.connections).toHaveLength(0);
      expect(logger).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("bounds connecting with the per-operation authTimeoutMs, not a client timeout", async () => {
    const login = deferred();
    const fake = fakeDriver({ connectGate: login.promise });
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({ account: "test", token: "t" }),
    });
    try {
      await expect(client.query("SELECT 1", { authTimeoutMs: 20 })).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      expect(fake.connections).toHaveLength(1);
    } finally {
      login.resolve();
      await client.close();
    }
    expect(() =>
      createSarClient({ timeouts: { authMs: 5_000 } } as unknown as SarClientOptions),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Unknown timeouts option: authMs",
      }),
    );
  });
  it("borrows a supplied provider, which stays usable after the client closes", async () => {
    const supplied = createConnectionOptions({
      account: "test",
      authenticator: "OAUTH",
      token: "t",
    });
    const client = createSarClient({ connectionOptions: supplied });
    await client.close();
    expect(supplied.getOwnerOptions().token).toBe("t");
    expect(supplied.getCallerOptions("alice").token).toBe("t.alice");
  });
  it("accepts a logger alongside connectionOptions", async () => {
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions({ account: "test", token: "t" }),
      logger,
    });
    try {
      await client.connect();
      expect(logger.mock.calls).toEqual([
        [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
      ]);
    } finally {
      await client.close();
    }
  });
  it.each([
    ["connection", { name: "dev" }],
    ["environment", "local"],
    ["platform", "spcs"],
    ["interactive", "always"],
    ["callerFallback", "error"],
    ["callerAsOwner", true],
    ["driverOptions", { clientStoreTemporaryCredential: true }],
  ] as const)("rejects the removed %s client option", (key, value) => {
    const supplied = createConnectionOptions({ account: "test", token: "t" });
    const unknown = expect.objectContaining({
      code: "INVALID_OPTIONS",
      message: `Unknown client option: ${key}`,
    });
    for (const settings of [
      { [key]: value },
      { connectionOptions: supplied, [key]: value },
      { connectionOptions: supplied, [key]: undefined },
    ])
      expect(() => createSarClient(settings as SarClientOptions)).toThrow(unknown);
  });
  it.each([
    [{ logger: "console" }, "logger must be a function"],
    [{ authTimeoutMs: 1_000 }, "Unknown client option: authTimeoutMs"],
    [{ timeouts: { authMs: 1_000 } }, "Unknown timeouts option: authMs"],
    [
      { connectionOptions: {} },
      "connectionOptions must implement owner and caller options getters",
    ],
  ])("validates client settings at runtime: %o", (settings, message) => {
    expect(() => createSarClient(settings as unknown as SarClientOptions)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", message }),
    );
  });
});

describe("callerAsOwner", () => {
  it("runs every caller view as the owner, with or without caller context", async () => {
    await profiles();
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromToml({ name: "dev" }), {
        callerAsOwner: true,
      }),
      logger,
    });
    try {
      await client.asCaller(missingCaller).query("SELECT 1");
      await client.asCaller({ headers: new Headers() }).withConnection(async () => {});
      await client.asCaller({ token: "alice" }).query("SELECT 2");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "dev-token",
        "dev-token",
        "dev-token",
      ]);
      for (const connection of fake.connections) expect(connection.destroy).toHaveBeenCalledOnce();
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
  });
  it("refuses missing callers even with preview evidence, since nothing is detected", async () => {
    mountedFiles.set("/snowflake/session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_PREVIEW_ORIGIN", "https://preview.invalid");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform()),
      logger,
    });
    try {
      expect(() => client.asCaller(missingCaller)).toThrow(
        expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
      );
      expect(fake.connections).toHaveLength(0);
      expect(logger).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("runs a present preview caller token as the owner under callerAsOwner", async () => {
    mountedFiles.set("/snowflake/session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_PREVIEW_ORIGIN", "https://preview.invalid");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const logger = vi.fn();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform()),
    });
    const owner = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform(), {
        callerAsOwner: true,
      }),
      logger,
    });
    const headers = new Headers({ "sf-context-current-user-token": "preview-user" });
    try {
      await client.asCaller({ headers }).query("SELECT 1");
      await owner.asCaller({ headers }).query("SELECT 2");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "service-token.preview-user",
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
  it("refuses missing callers on a platform token unless callerAsOwner is set", async () => {
    mountedFiles.set("/snowflake/session/token", "service-token");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform(), {
        callerAsOwner: false,
      }),
    });
    const owner = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(fromPlatform(), {
        callerAsOwner: true,
      }),
    });
    try {
      expect(() => client.asCaller(missingCaller)).toThrow(
        expect.objectContaining({
          code: "CALLER_CONTEXT_REQUIRED",
          message: "Caller context carries no caller token",
          details: { nextStep: nextSteps.callerContext },
        }),
      );
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
      connectionOptions: createConnectionOptions(fromToml({ name: "dev" }), {
        callerAsOwner: false,
      }),
    });
    try {
      // The view itself is refused, so no detached caller method can run.
      expect(() => client.asCaller(missingCaller)).toThrow(
        expect.objectContaining({
          code: "CALLER_CONTEXT_REQUIRED",
          details: { nextStep: nextSteps.callerContext },
        }),
      );
      await expect(client.asCaller({ token: "alice" }).pollQuery(reference)).rejects.toMatchObject({
        code: "QUERY_IDENTITY_MISMATCH",
      });
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
  const ownerConnection = { account: "test", authenticator: "OAUTH", token: "owner" };
  it.each([
    [{ callerAsOwner: true }, "owner"],
    [{ callerAsOwner: false }, "owner.alice"],
    [{}, "owner.alice"],
  ] as const)("returns caller options under %j", (settings, token) => {
    const options = createConnectionOptions(ownerConnection, settings);
    expect(options.getCallerOptions("alice").token).toBe(token);
  });
  it.each([
    [ownerConnection, {}, "", "CALLER_CONTEXT_REQUIRED", undefined],
    [ownerConnection, { callerAsOwner: true }, " ", "CALLER_CONTEXT_REQUIRED", undefined],
    [{ account: "test" }, {}, "alice", "AUTH_NOT_SUPPORTED", "callerToken"],
    [{ account: "test" }, { callerAsOwner: false }, "alice", "AUTH_NOT_SUPPORTED", "callerToken"],
  ] as const)(
    "refuses caller options for %j under %j with token %j",
    (connection, settings, callerToken, code, hint) => {
      const options = createConnectionOptions(connection, settings);
      let error: unknown;
      try {
        options.getCallerOptions(callerToken);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toMatchObject({ code });
      expect((error as SarError).details.nextStep).toBe(hint && nextSteps[hint]);
    },
  );
  it.each(["auto", "error", "unless-deployed"])(
    "rejects the removed callerFallback %s policy on the factory and the client",
    (callerFallback) => {
      const connection = { account: "test", token: "t" };
      expect(() => createConnectionOptions(connection, { callerFallback } as never)).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "Unknown connection options option: callerFallback",
        }),
      );
      expect(() =>
        createSarClient({
          connectionOptions: createConnectionOptions(connection),
          callerFallback,
        } as unknown as SarClientOptions),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "Unknown client option: callerFallback",
        }),
      );
    },
  );
});

describe("nextStep hints", () => {
  it("suggests ingress or callerAsOwner when a caller view has no caller token", async () => {
    await profiles();
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: createConnectionOptions(fromToml({ name: "dev" })),
    });
    try {
      let error: unknown;
      try {
        client.asCaller(missingCaller);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        message: "Caller context carries no caller token",
        details: { nextStep: nextSteps.callerContext },
      });
      expect(nextSteps.callerContext).toContain("callerAsOwner: true");
      expect(nextSteps.callerContext).not.toContain("unless-deployed");
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        nextStep: nextSteps.callerContext,
      });
      expect(JSON.stringify(error)).not.toContain(directory);
    } finally {
      await client.close();
    }
  });
  it("points to SnowCLI discovery when no profile is configured", async () => {
    const client = createSarClient({ driver: fakeDriver().driver });
    try {
      const unconfigured = await client.connect().catch((error: unknown) => error);
      expect(unconfigured).toMatchObject({
        code: "AUTH_NOT_FOUND",
        message:
          "No connection options configured. Pass connectionOptions: createConnectionOptions(...).",
      });
      expect(unconfigured).not.toHaveProperty("details.nextStep");
      let error: unknown;
      try {
        fromToml();
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toMatchObject({
        code: "CONFIG_NOT_FOUND",
        details: { nextStep: nextSteps.discovery },
      });
      expect(JSON.stringify(error)).toContain("fromToml({ name })");
      expect(JSON.stringify(error)).not.toContain(directory);
    } finally {
      await client.close();
    }
  });
  it("keeps the discovery hint through the client when a lazy source selects a missing profile", async () => {
    await profiles();
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: lazily(() => fromToml({ name: "missing" })),
    });
    try {
      await expect(client.connect()).rejects.toMatchObject({
        code: "CONFIG_NOT_FOUND",
        message: "Selected connection 'missing' was not found",
        details: { nextStep: nextSteps.discovery },
      });
    } finally {
      await client.close();
    }
  });
  it("ignores SNOWFLAKE_CONNECTION_NAME, selecting the configured default", async () => {
    vi.stubEnv("SNOWFLAKE_CONNECTION_NAME", "missing");
    await profiles();
    expect(fromToml().token).toBe("default-token");
  });
  it("points to configFile when an explicit configuration file is absent", async () => {
    const configFile = path.join(directory, "absent.toml");
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: lazily(() => fromToml({ configFile })),
    });
    try {
      for (const operation of [
        () => client.connect(),
        async () => createConnectionOptions(fromToml({ configFile })),
      ]) {
        const error = await operation().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "CONFIG_NOT_FOUND",
          details: { nextStep: nextSteps.configFile },
        });
        expect(JSON.stringify(error)).not.toContain(directory);
      }
    } finally {
      await client.close();
    }
  });
  it("keeps nextStep when a detached lookup re-wraps the failure", async () => {
    await profiles();
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: lazily(() => fromToml({ name: "missing" })),
    });
    try {
      await expect(client.pollQuery(reference)).rejects.toMatchObject({
        code: "CONFIG_NOT_FOUND",
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
  it("passes through a hint that a provider's SarError supplies", async () => {
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: {
        getOwnerOptions() {
          throw new SarError("CONFIG_NOT_FOUND", "synthetic", { nextStep: "synthetic-hint" });
        },
        getCallerOptions() {
          throw new SarError("CONFIG_NOT_FOUND", "synthetic", { nextStep: "synthetic-hint" });
        },
      },
    });
    try {
      const error = await client.connect().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "CONFIG_NOT_FOUND",
        details: { nextStep: "synthetic-hint" },
      });
    } finally {
      await client.close();
    }
  });
});
