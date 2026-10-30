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

import { afterEach, describe, expect, it, vi } from "vitest";
import type snowflake from "snowflake-sdk";
import { createSarClient } from "../src/index.js";
import {
  createConnectionOptions,
  type ConnectionOptionsFactoryOptions,
} from "../src/connection-options/index.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { HttpTransport } from "../src/core/http.js";
import { nextSteps } from "../src/core/errors.js";
import { fakeDriver } from "./fake-driver.js";
import { fakeQueryService } from "./fake-query-service.js";
import type { CallerContext, PoolOptions, SarClientOptions } from "../src/index.js";

vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    throw new Error("Unexpected dispatcher creation");
  }),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected network call");
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const connection = (): snowflake.ConnectionOptions => ({
  account: "test",
  authenticator: "OAUTH",
  token: "owner-token",
  role: "APP_ROLE",
  warehouse: "APP_WH",
});
const aliceHeaders = new Headers({ "sf-context-current-user-token": "alice" });
const missingCaller = { headers: new Headers() };
const options = (settings: ConnectionOptionsFactoryOptions = {}) =>
  createConnectionOptions(connection(), settings);
function setup(settings: ConnectionOptionsFactoryOptions = {}, pool?: PoolOptions) {
  const fake = fakeDriver();
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: options(settings),
    ...(pool ? { pool } : {}),
  });
  return { ...fake, client, close: () => client.close() };
}
const transport = () =>
  vi
    .spyOn(HttpTransport.prototype, "fetch")
    .mockImplementation(async () => new Response(null, { status: 204 }));
const authorizations = (spy: ReturnType<typeof transport>) =>
  spy.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));

describe("callerAsOwner", () => {
  it("returns the owner options as caller options", () => {
    const factory = options({ callerAsOwner: true });
    const owner = factory.getOwnerOptions();
    expect(owner).toMatchObject({ token: "owner-token", role: "APP_ROLE", warehouse: "APP_WH" });
    expect(factory.getCallerOptions("alice")).toEqual(owner);
    expect(factory.getCallerOptions("bob")).toEqual(owner);
  });
  it.each<[string, CallerContext]>([
    ["caller headers", { headers: aliceHeaders }],
    ["an explicit token", { token: "alice" }],
    ["missing caller context", missingCaller],
  ])("runs caller views with %s as the owner", async (_label, context) => {
    const { client, connections, close } = setup({ callerAsOwner: true });
    const http = transport();
    try {
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
    }
  });
  it("allows detached caller methods and saves owner references", async () => {
    const service = fakeQueryService();
    const client = createSarClient({
      driver: service.driver,
      connectionOptions: options({ callerAsOwner: true }),
    });
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
  it("runs a connection with no token as the owner, where callers would be refused", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(
        { account: "test", username: "app", password: "synthetic" },
        { callerAsOwner: true },
      ),
    });
    try {
      await client.asCaller({ token: "alice" }).query("SELECT 1");
      await client.asCaller(missingCaller).query("SELECT 2");
      expect(fake.connections.map((connection) => connection.config)).toEqual([
        expect.objectContaining({ username: "app", password: "synthetic" }),
        expect.objectContaining({ username: "app", password: "synthetic" }),
      ]);
      for (const { config } of fake.connections) expect(config).not.toHaveProperty("token");
    } finally {
      await client.close();
    }
  });
  it("logs caller views as owner sessions", async () => {
    const logger = vi.fn();
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: options({ callerAsOwner: true }),
      logger,
    });
    try {
      await client.asCaller(missingCaller).query("SELECT 1");
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
      await client.close();
    }
  });
  it.each([false, undefined])(
    "keeps caller credentials and caller sessions with callerAsOwner: %s",
    async (callerAsOwner) => {
      const { client, connections, close } = setup({ callerAsOwner });
      const http = transport();
      try {
        const alice = client.asCaller({ headers: aliceHeaders });
        await alice.query("SELECT 1");
        await alice.withConnection(async () => {});
        await alice.fetch("/api/v2/test");
        expect(connections).toHaveLength(1);
        expect(connections[0]?.config.token).toBe("owner-token.alice");
        expect(connections[0]?.destroy).not.toHaveBeenCalled();
        expect(authorizations(http)).toEqual(["Bearer owner-token.alice"]);
        expect(() => client.asCaller(missingCaller)).toThrow(
          expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
        );
      } finally {
        await close();
      }
      expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    },
  );
  it("keeps caller references and present-caller checks for detached methods when false", async () => {
    const service = fakeQueryService();
    const client = createSarClient({
      driver: service.driver,
      connectionOptions: options({ callerAsOwner: false }),
    });
    try {
      const reference = await client.asCaller({ token: "alice" }).submitDetached("SELECT 1");
      expect(reference.mode).toBe("caller");
      expect(service.connections[0]?.config.token).toBe("owner-token.alice");
      expect(() => client.asCaller(missingCaller)).toThrow(
        expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
      );
      await expect(client.getQueryStatus(reference)).rejects.toMatchObject({
        code: "QUERY_IDENTITY_MISMATCH",
      });
      expect(service.connections).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
  it.each([
    [null, "INVALID_OPTIONS"],
    [{ cookie: "alice" }, "INVALID_OPTIONS"],
    [{ headers: aliceHeaders, token: "alice" }, "INVALID_OPTIONS"],
    [{ headers: {} }, "INVALID_OPTIONS"],
    [{ token: " " }, "CALLER_CONTEXT_REQUIRED"],
    [{ headers: { get: () => " " } }, "CALLER_CONTEXT_REQUIRED"],
  ])("still rejects caller context %o without reading credentials", async (context, code) => {
    const read = vi.fn(() => "owner-token");
    const lazy = { account: "test" } as snowflake.ConnectionOptions;
    Object.defineProperty(lazy, "token", { enumerable: true, get: read });
    const factory = createConnectionOptions(lazy, { callerAsOwner: true });
    const client = createSarClient({ driver: fakeDriver().driver, connectionOptions: factory });
    const manager = createConnectionManager(factory, { driver: fakeDriver().driver });
    const fetcher = createFetchClient(factory);
    try {
      for (const component of [client, manager, fetcher])
        expect(() => component.asCaller(context as never)).toThrow(
          expect.objectContaining({ code }),
        );
      expect(read).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), manager.close(), fetcher.close()]);
    }
  });
  it.each(["", " ", undefined, 42])(
    "still rejects the caller token %o from getCallerOptions()",
    (token) => {
      expect(() => options({ callerAsOwner: true }).getCallerOptions(token as never)).toThrow(
        expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
      );
    },
  );
  it.each(["true", 1, null, {}])("rejects callerAsOwner: %o", (value) => {
    expect(() => createConnectionOptions(connection(), { callerAsOwner: value as never })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "callerAsOwner must be a boolean",
      }),
    );
  });
  it.each([true, false, undefined])(
    "is a connection option, not a client option (%s): createSarClient rejects it",
    async (callerAsOwner) => {
      const supplied = options({ callerAsOwner: true });
      const fake = fakeDriver();
      expect(() =>
        createSarClient({
          connectionOptions: supplied,
          callerAsOwner,
        } as unknown as SarClientOptions),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "Unknown client option: callerAsOwner",
        }),
      );
      // The supplied factory's setting applies.
      const client = createSarClient({ driver: fake.driver, connectionOptions: supplied });
      await client.asCaller({ token: "alice" }).query("SELECT 1");
      await client.close();
      expect(fake.connections[0]?.config.token).toBe("owner-token");
    },
  );
  it("is what the missing-caller hint suggests, and setting it runs the view as the owner", async () => {
    const fake = fakeDriver();
    const strict = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(connection()),
    });
    const owner = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(connection(), { callerAsOwner: true }),
    });
    try {
      expect(() => strict.asCaller(missingCaller)).toThrow(
        expect.objectContaining({
          code: "CALLER_CONTEXT_REQUIRED",
          details: { nextStep: nextSteps.callerContext },
        }),
      );
      expect(nextSteps.callerContext).toContain(
        "set callerAsOwner: true to run caller views with owner credentials",
      );
      expect(nextSteps.callerContext).not.toMatch(/unless-deployed|owner-token|[\\/~]/);
      expect(fake.connections).toHaveLength(0);
      await owner.asCaller(missingCaller).query("SELECT 1");
      expect(fake.connections[0]?.config.token).toBe("owner-token");
    } finally {
      await Promise.all([strict.close(), owner.close()]);
    }
  });
  it("points a missing connection token at callerAsOwner", () => {
    const factory = createConnectionOptions({ account: "test", password: "synthetic" });
    expect(() => factory.getCallerOptions("alice")).toThrow(
      expect.objectContaining({
        code: "AUTH_NOT_SUPPORTED",
        details: { nextStep: nextSteps.callerToken },
      }),
    );
  });
});
