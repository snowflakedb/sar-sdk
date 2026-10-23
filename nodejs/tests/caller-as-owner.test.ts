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
import { createSarClient } from "../src/index.js";
import {
  createConnectionOptions,
  fromCredentials,
  type AuthProvider,
  type ConnectionOptionsFactoryOptions,
} from "../src/auth.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import { createFetchClient } from "../src/account-http.js";
import { HttpTransport } from "../src/http.js";
import { nextSteps } from "../src/errors.js";
import { fakeDriver } from "./fake-driver.js";
import { fakeQueryService } from "./fake-query-service.js";
import type { CallerContext, PoolOptions, SarClientOptions } from "../src/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async (...args: Parameters<typeof actual.access>) => {
      if (String(args[0]).startsWith("/snowflake/"))
        throw Object.assign(new Error("Synthetic absent mount"), { code: "ENOENT" });
      return actual.access(...args);
    }),
  };
});
vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    throw new Error("Unexpected dispatcher creation");
  }),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected network call");
  }),
}));

beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  // Without platform evidence or an explicit environment, CI keeps detection at "unknown".
  vi.stubEnv("CI", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// An SPCS source, so a present caller token would otherwise compose a caller credential.
const spcs: AuthProvider = {
  id: "synthetic-spcs",
  async resolve() {
    return {
      target: { account: "test", role: "APP_ROLE", warehouse: "APP_WH" },
      platform: "spcs",
      async acquire() {
        return { type: "oauth", token: "owner-token" };
      },
    };
  },
};
const aliceHeaders = new Headers({ "sf-context-current-user-token": "alice" });
const missingCaller = { headers: new Headers() };
type FactorySettings = Pick<
  ConnectionOptionsFactoryOptions,
  "callerAsOwner" | "environment" | "logger"
>;
const options = (settings: FactorySettings = {}) =>
  createConnectionOptions(spcs, { environment: "deployed", platform: "spcs", ...settings });
function setup(settings: FactorySettings = {}, pool?: PoolOptions) {
  const fake = fakeDriver();
  const factory = options(settings);
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: factory,
    ...(pool ? { pool } : {}),
  });
  return {
    ...fake,
    factory,
    client,
    async close() {
      await client.close();
      await factory.close();
    },
  };
}
const transport = () =>
  vi
    .spyOn(HttpTransport.prototype, "fetch")
    .mockImplementation(async () => new Response(null, { status: 204 }));
const authorizations = (spy: ReturnType<typeof transport>) =>
  spy.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));

describe("callerAsOwner", () => {
  it.each<[string, CallerContext]>([
    ["caller headers", { headers: aliceHeaders }],
    ["an explicit token", { token: "alice" }],
    ["missing caller context", missingCaller],
  ])("runs caller views with %s as the owner", async (_label, context) => {
    const { client, factory, connections, close } = setup({ callerAsOwner: true });
    const http = transport();
    try {
      const owner = await factory.getOwnerOptions();
      expect(owner).toMatchObject({ token: "owner-token", role: "APP_ROLE", warehouse: "APP_WH" });
      expect(await factory.getCallerOptions(context)).toEqual(owner);
      const caller = client.asCaller(context);
      await client.query("SELECT 1");
      await caller.query("SELECT 2");
      await caller.withConnection(async () => {});
      expect(connections).toHaveLength(3);
      expect(connections[0]?.config).toMatchObject({ token: "owner-token", role: "APP_ROLE" });
      for (const connection of connections.slice(1))
        expect(connection.config).toEqual(connections[0]?.config);
      await client.fetch("/api/v2/owner");
      await caller.fetch("/api/v2/caller");
      expect(http.mock.calls.map(([url]) => url)).toEqual([
        "https://test.snowflakecomputing.com/api/v2/owner",
        "https://test.snowflakecomputing.com/api/v2/caller",
      ]);
      expect(authorizations(http)).toEqual(["Bearer owner-token", "Bearer owner-token"]);
    } finally {
      await close();
    }
  });
  it("runs caller views of standalone components built on the factory as the owner", async () => {
    const fake = fakeDriver();
    const factory = options({ callerAsOwner: true });
    const manager = createConnectionManager(factory, { driver: fake.driver });
    const queries = createQueryClient(manager);
    const scoped = createQueryClient(manager.asCaller({ token: "alice" }));
    const fetcher = createFetchClient(factory);
    const http = transport();
    try {
      await manager.asCaller({ token: "alice" }).withConnection(async () => {});
      await manager.asCaller({ headers: aliceHeaders }).withConnection(async () => {});
      await queries.asCaller({ headers: aliceHeaders }).query("SELECT 1");
      await scoped.query("SELECT 2");
      await fetcher.asCaller({ token: "alice" }).fetch("/api/v2/test");
      expect(fake.connections.map((connection) => connection.config.token)).toEqual([
        "owner-token",
        "owner-token",
        "owner-token",
        "owner-token",
      ]);
      expect(authorizations(http)).toEqual(["Bearer owner-token"]);
    } finally {
      await Promise.all([scoped.close(), queries.close(), fetcher.close()]);
      await manager.close();
      await factory.close();
    }
  });
  it("allows detached caller methods and saves owner references", async () => {
    const service = fakeQueryService();
    const factory = options({ callerAsOwner: true });
    const client = createSarClient({ driver: service.driver, connectionOptions: factory });
    try {
      const present = client.asCaller({ headers: aliceHeaders });
      const missing = client.asCaller(missingCaller);
      const reference = await present.submitDetached("SELECT 1");
      const other = await missing.submitDetached("SELECT 2");
      expect([reference.mode, other.mode]).toEqual(["owner", "owner"]);
      expect(await client.getQueryStatus(reference)).toBe("RUNNING");
      expect(await missing.getQueryStatus(reference)).toBe("RUNNING");
      service.queries.get(reference.queryId)!.status = "SUCCESS";
      expect(await present.pollQuery(reference)).toMatchObject({
        status: "complete",
        result: { rowCount: 1 },
      });
      await expect(present.getQueryStatus({ ...reference, mode: "caller" })).rejects.toMatchObject({
        code: "QUERY_IDENTITY_MISMATCH",
      });
      expect(service.connections.map((connection) => connection.config.token)).toEqual([
        "owner-token",
        "owner-token",
        "owner-token",
        "owner-token",
        "owner-token",
      ]);
    } finally {
      await client.close();
      await factory.close();
    }
  });
  it("gives caller-view operations fresh owner sessions without deferred logout", async () => {
    const { client, connections, close } = setup({ callerAsOwner: true });
    try {
      const alice = client.asCaller({ headers: aliceHeaders });
      await alice.query("SELECT 1");
      for await (const row of await alice.stream("SELECT 2")) expect(row).toBeDefined();
      await alice.withConnection(async () => {});
      await client.asCaller({ headers: aliceHeaders }).withConnection(async () => {});
      expect(connections).toHaveLength(4);
      for (const connection of connections) {
        expect(connection.connect).toHaveBeenCalledOnce();
        expect(connection.destroy).toHaveBeenCalledOnce();
      }
      expect((await client.diagnostics()).physicalConnections).toBe(0);
    } finally {
      await close();
    }
    for (const connection of connections) expect(connection.destroy).toHaveBeenCalledOnce();
  });
  it("shares the owner's reusable sessions instead of keeping sessions per view", async () => {
    const reset = vi.fn(async () => {});
    const { client, connections, close } = setup(
      { callerAsOwner: true },
      { mode: "reusable", reset },
    );
    try {
      await client.query("SELECT 1");
      await client.asCaller({ token: "alice" }).query("SELECT 2");
      await client.asCaller({ headers: aliceHeaders }).withConnection(async () => {});
      expect(connections).toHaveLength(1);
      expect(connections[0]?.config.token).toBe("owner-token");
      expect(reset).toHaveBeenCalledTimes(3);
    } finally {
      await close();
    }
  });
  it.each([false, undefined])(
    "keeps caller credentials and caller sessions with callerAsOwner: %s",
    async (callerAsOwner) => {
      const { client, factory, connections, close } = setup({ callerAsOwner });
      const http = transport();
      try {
        expect((await factory.getCallerOptions({ token: "alice" })).token).toBe(
          "owner-token.alice",
        );
        const alice = client.asCaller({ headers: aliceHeaders });
        await alice.query("SELECT 1");
        await alice.withConnection(async () => {});
        await alice.fetch("/api/v2/test");
        expect(connections).toHaveLength(1);
        expect(connections[0]?.config.token).toBe("owner-token.alice");
        expect(connections[0]?.destroy).not.toHaveBeenCalled();
        expect(authorizations(http)).toEqual(["Bearer owner-token.alice"]);
        await expect(client.asCaller(missingCaller).query("SELECT 2")).rejects.toMatchObject({
          code: "CALLER_CONTEXT_REQUIRED",
        });
      } finally {
        await close();
      }
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    },
  );
  it("keeps caller references and present-caller checks for detached methods when false", async () => {
    const service = fakeQueryService();
    const factory = options({ callerAsOwner: false });
    const client = createSarClient({ driver: service.driver, connectionOptions: factory });
    try {
      const reference = await client.asCaller({ token: "alice" }).submitDetached("SELECT 1");
      expect(reference.mode).toBe("caller");
      expect(service.connections[0]?.config.token).toBe("owner-token.alice");
      await expect(client.asCaller(missingCaller).submitDetached("SELECT 2")).rejects.toMatchObject(
        { code: "CALLER_CONTEXT_REQUIRED" },
      );
      await expect(client.getQueryStatus(reference)).rejects.toMatchObject({
        code: "QUERY_IDENTITY_MISMATCH",
      });
      expect(service.connections).toHaveLength(1);
    } finally {
      await client.close();
      await factory.close();
    }
  });
  it("doesn't report a caller fallback where callerFallback would fall back", async () => {
    const logger = vi.fn();
    const fallbackLogger = vi.fn();
    const owner = setup({ callerAsOwner: true, environment: "local", logger });
    const fallback = setup({ environment: "local", logger: fallbackLogger });
    try {
      await owner.client.asCaller(missingCaller).query("SELECT 1");
      expect((await owner.factory.getCallerOptions(missingCaller)).token).toBe("owner-token");
      await fallback.client.asCaller(missingCaller).query("SELECT 1");
      expect(owner.connections[0]?.config.token).toBe("owner-token");
      const succeeded = {
        event: "query-succeeded",
        queryId: expect.any(String),
        durationMs: expect.any(Number),
        rowCount: 1,
      };
      expect(logger.mock.calls).toEqual([
        [{ event: "session-opened", mode: "owner", durationMs: expect.any(Number) }],
        [succeeded],
      ]);
      expect(fallbackLogger.mock.calls).toEqual([
        [{ event: "caller-fallback", environment: "local" }],
        [{ event: "session-opened", mode: "caller", durationMs: expect.any(Number) }],
        [succeeded],
      ]);
    } finally {
      await Promise.all([owner.close(), fallback.close()]);
    }
  });
  it.each([
    [null, "INVALID_OPTIONS"],
    [{ cookie: "alice" }, "INVALID_OPTIONS"],
    [{ headers: aliceHeaders, token: "alice" }, "INVALID_OPTIONS"],
    [{ headers: {} }, "INVALID_OPTIONS"],
    [{ token: " " }, "CALLER_CONTEXT_REQUIRED"],
    [{ headers: { get: () => " " } }, "CALLER_CONTEXT_REQUIRED"],
  ])("still rejects caller context %o without acquiring credentials", async (context, code) => {
    const resolve = vi.fn();
    const factory = createConnectionOptions({ id: "synthetic", resolve }, { callerAsOwner: true });
    const client = createSarClient({ driver: fakeDriver().driver, connectionOptions: factory });
    const manager = createConnectionManager(factory, { driver: fakeDriver().driver });
    const fetcher = createFetchClient(factory);
    try {
      for (const component of [client, manager, fetcher])
        expect(() => component.asCaller(context as never)).toThrow(
          expect.objectContaining({ code }),
        );
      await expect(factory.getCallerOptions(context as never)).rejects.toMatchObject({ code });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), manager.close(), fetcher.close()]);
      await factory.close();
    }
  });
  it.each(["true", 1, null, {}])("rejects callerAsOwner: %o", (value) => {
    const invalid = expect.objectContaining({
      code: "INVALID_OPTIONS",
      message: "callerAsOwner must be a boolean",
    });
    expect(() => createConnectionOptions([], { callerAsOwner: value as never })).toThrow(invalid);
    expect(() => createSarClient({ callerAsOwner: value as never })).toThrow(invalid);
  });
  it.each([true, false])(
    "can't be combined with connectionOptions (%s); the supplied factory's setting applies",
    async (callerAsOwner) => {
      const supplied = options({ callerAsOwner: true });
      const fake = fakeDriver();
      try {
        expect(() =>
          createSarClient({
            connectionOptions: supplied,
            callerAsOwner,
          } as unknown as SarClientOptions),
        ).toThrow(
          expect.objectContaining({
            code: "INVALID_OPTIONS",
            message:
              "callerAsOwner cannot be combined with connectionOptions; configure the supplied provider instead",
          }),
        );
        const client = createSarClient({
          driver: fake.driver,
          connectionOptions: supplied,
          callerAsOwner: undefined,
        });
        await client.asCaller({ token: "alice" }).query("SELECT 1");
        await client.close();
        expect(fake.connections[0]?.config.token).toBe("owner-token");
      } finally {
        await supplied.close();
      }
    },
  );
  it("is what the missing-caller hint suggests, and setting it runs the view as the owner", async () => {
    const provider = fromCredentials({
      target: { account: "test" },
      credential: { type: "oauth", token: "owner-token" },
    });
    const fake = fakeDriver();
    const strictOptions = createConnectionOptions(provider);
    const ownerOptions = createConnectionOptions(provider, { callerAsOwner: true });
    const strict = createSarClient({ driver: fake.driver, connectionOptions: strictOptions });
    const owner = createSarClient({ driver: fake.driver, connectionOptions: ownerOptions });
    try {
      expect((await strict.diagnostics()).environment).toBe("unknown");
      await expect(strict.asCaller(missingCaller).query("SELECT 1")).rejects.toMatchObject({
        code: "CALLER_CONTEXT_REQUIRED",
        details: { nextStep: nextSteps.callerFallback },
      });
      expect(nextSteps.callerFallback).toContain("set callerAsOwner: true in local development");
      expect(nextSteps.callerFallback).not.toMatch(/unless-deployed|owner-token|[\\/~]/);
      expect(fake.connections).toHaveLength(0);
      await owner.asCaller(missingCaller).query("SELECT 1");
      expect(fake.connections[0]?.config.token).toBe("owner-token");
    } finally {
      await Promise.all([strict.close(), owner.close()]);
      await Promise.all([strictOptions.close(), ownerOptions.close()]);
    }
  });
});
