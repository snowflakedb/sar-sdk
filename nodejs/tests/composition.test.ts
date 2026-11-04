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
import { createConnectionOptions } from "../src/connection-options/index.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { createSecretsClient } from "../src/secrets-client/index.js";
import { createSarClient } from "../src/sar-client.js";
import { createTestClient, unconfigured } from "./test-client.js";

import type { ConnectionManagerOptions } from "../src/index.js";
import { fakeDriver } from "./fake-driver.js";

const fetchMock = vi.hoisted(() =>
  vi.fn(async (_url: string, _init: { headers: Headers }) => new Response("ok")),
);
vi.mock("undici", () => ({
  fetch: fetchMock,
  EnvHttpProxyAgent: class {
    async destroy() {}
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fetchMock.mockClear();
});
function authOptions() {
  return createConnectionOptions({
    account: "test",
    accessUrl: "https://test.snowflakecomputing.com",
    authenticator: "OAUTH",
    token: "spcs.synthetic-owner",
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("independent authentication", () => {
  it("reads detached options repeatedly without SQL and isolates caller scopes", () => {
    const auth = authOptions();
    const owner = auth.getOwnerOptions();
    expect(owner).toMatchObject({ authenticator: "OAUTH", token: "spcs.synthetic-owner" });
    expect(auth.getCallerOptions("synthetic-caller")).toMatchObject({
      authenticator: "OAUTH",
      token: "spcs.synthetic-owner.synthetic-caller",
    });
    expect(auth.getOwnerOptions()).toMatchObject({ token: "spcs.synthetic-owner" });
    expect(auth.getOwnerOptions()).not.toBe(owner);
  });
  it("rejects invalid resolvers and conflicting configuration", () => {
    const auth = authOptions();
    expect(() => createConnectionManager({} as never)).toThrow();
    expect(() =>
      createConnectionManager(auth, { connection: { account: "other" } } as never),
    ).toThrow();
    expect(() => createFetchClient(auth, { platform: "serverless" } as never)).toThrow();
  });
});

describe("component ownership", () => {
  it.each(["manager", "http", "aggregate"])(
    "snapshots borrowed auth ownership in %s",
    async (component) => {
      const auth = authOptions();
      const input: { connectionOptions?: typeof auth } = { connectionOptions: auth };
      const client =
        component === "manager"
          ? createConnectionManager(input.connectionOptions)
          : component === "http"
            ? createFetchClient(input.connectionOptions)
            : createTestClient(input);
      input.connectionOptions = undefined;
      await client.close();
      expect(auth.getOwnerOptions()).toHaveProperty("token");
    },
  );
  it("HTTP and secrets work without a driver or SQL-capable client", async () => {
    const auth = authOptions();
    const http = createFetchClient(auth);
    const secrets = createSecretsClient({
      providers: [
        {
          id: "test",
          async resolve() {
            return "synthetic-secret";
          },
        },
      ],
    });
    expect(await secrets.getString("KEY")).toBe("synthetic-secret");
    expect(await (await http.fetch("/api/v2/test")).text()).toBe("ok");
    const caller = http.asCaller({ token: "synthetic-caller" });
    await caller.fetch("/api/v2/test");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers.get("authorization")).toBe(
      "Bearer spcs.synthetic-owner.synthetic-caller",
    );
    await Promise.all([http.close(), secrets.close()]);
    expect(auth.getOwnerOptions().authenticator).toBe("OAUTH");
    await expect(caller.fetch("/api/v2/test")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(secrets.getString("KEY")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => http.asCaller({ token: "test" })).toThrow();
  });
  it("standalone fetch with unusable connection options fails and has idempotent shutdown", async () => {
    const http = createFetchClient(unconfigured);
    await expect(http.fetch("/api/v2/test")).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
    const closing = http.close();
    expect(http.close()).toBe(closing);
    await closing;
  });
  it("a query client owns its manager: close cancels its own leases, then closes the manager", async () => {
    const fake = fakeDriver({ status: "RUNNING" });
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const queries = createQueryClient(manager);
    const handle = await queries.submit("synthetic");
    await expect(queries.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await expect(handle.result()).rejects.toMatchObject({ code: "ABORTED" });
    await expect(manager.withConnection(async () => {})).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });
  it("scoped queries cannot select an owner or caller identity", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const scoped = createQueryClient(manager.asCaller({ token: "synthetic-caller" }));
    expect("asCaller" in scoped).toBe(false);
    await scoped.query("synthetic");
    expect(fake.connections[0]?.config.token).toBe("spcs.synthetic-owner.synthetic-caller");
    await scoped.close();
    await manager.close();
  });
  it("a query client's caller view stops with its owner and keeps native access", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const queries = createQueryClient(manager);
    const caller = queries.asCaller({ token: "synthetic-caller" });
    await caller.query("synthetic");
    await queries.close();
    await expect(caller.query("synthetic")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => queries.asCaller({ token: "another" })).toThrow();
    expect(() => manager.asCaller({ token: "test" })).toThrow();
  });
  it("query close can wait for an existing operation before closing its manager", async () => {
    const gate = deferred();
    const fake = fakeDriver({ fetchGate: gate.promise });
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const queries = createQueryClient(manager);
    const work = queries.query("synthetic");
    await vi.waitFor(() => expect(fake.connections).toHaveLength(1));
    const closing = queries.close();
    expect(queries.close()).toBe(closing);
    gate.resolve();
    await work;
    await closing;
    await expect(manager.connect()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("query close rejects pending admission at once; the owned manager destroys a connection it cannot drain", async () => {
    const gate = deferred();
    const started = deferred();
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), {
      driver: fake.driver,
      pool: { maxConnections: 1 },
    });
    const work = manager.withConnection(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    const queries = createQueryClient(manager);
    const pending = queries.query("synthetic");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(queries.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    gate.resolve();
    await work.catch(() => {});
  });
  it("aggregate borrows supplied auth and snapshots stateful headers exactly once", async () => {
    const fake = fakeDriver();
    const auth = authOptions();
    const client = createTestClient({ connectionOptions: auth, driver: fake.driver });
    const get = vi.fn().mockReturnValueOnce("synthetic-first").mockReturnValue("synthetic-other");
    const caller = client.asCaller({ headers: { get } });
    await caller.query("synthetic");
    await caller.fetch("/api/v2/test");
    expect(get).toHaveBeenCalledOnce();
    expect(fake.connections[0]?.config.token).toBe("spcs.synthetic-owner.synthetic-first");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers.get("authorization")).toBe(
      "Bearer spcs.synthetic-owner.synthetic-first",
    );
    await client.close();
    auth.getOwnerOptions();
  });
  it("rejects invalid query scopes and non-Promise native callbacks", async () => {
    expect(() => createQueryClient({} as never)).toThrow();
    expect(() => createQueryClient({} as never, { handleIdleTimeoutMs: 0 })).toThrow();
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    await expect(manager.withConnection((() => 1) as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(fake.connections[0]?.destroy).toHaveBeenCalledOnce();
    await manager.close();
  });
  it("manager withConnection takes only a callback; caller scopes select identity", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const headers = new Headers({ "sf-context-current-user-token": "synthetic-caller" });
    const callback = vi.fn(async () => "done");
    const untyped = manager as unknown as { withConnection(...args: unknown[]): Promise<unknown> };
    await expect(
      untyped.withConnection({ asCaller: true, headers }, callback),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message:
        "withConnection takes only a callback; use asCaller({ headers }).withConnection(callback) for caller identity",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(fake.connections).toHaveLength(0);
    expect(await manager.asCaller({ headers }).withConnection(callback)).toBe("done");
    expect(await manager.withConnection(callback)).toBe("done");
    expect(fake.connections.map((connection) => connection.config.token)).toEqual([
      "spcs.synthetic-owner.synthetic-caller",
      "spcs.synthetic-owner",
    ]);
    await manager.close();
  });
  it.each(["query", "fetch", "secrets"])("connection options reject unrelated %s", (key) => {
    expect(() =>
      createConnectionManager(undefined, { [key]: {} } as ConnectionManagerOptions),
    ).toThrow();
  });
});

describe("query client shutdown", () => {
  it("rejects native access as soon as close starts, while queries still drain", async () => {
    const gate = deferred();
    const fake = fakeDriver({ sqlGates: { synthetic: gate.promise } });
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const queries = createQueryClient(manager);
    const caller = queries.asCaller({ token: "alice" });
    const running = queries.query("synthetic");
    await vi.waitFor(() => expect(fake.connections[0]?.execute).toHaveBeenCalled());
    const closing = queries.close({ timeoutMs: 5_000 });
    const closed = expect.objectContaining({ code: "CLIENT_CLOSED" });
    await expect(queries.withConnection(async () => {})).rejects.toEqual(closed);
    await expect(queries.connect()).rejects.toEqual(closed);
    await expect(caller.withConnection(async () => {})).rejects.toEqual(closed);
    expect(fake.connections).toHaveLength(1);
    gate.resolve();
    await expect(running).resolves.toMatchObject({ rowCount: expect.any(Number) });
    await closing;
  });
  it("closes SQL and native work within one grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const gate = deferred();
      const started = deferred();
      const fake = fakeDriver({ sqlGates: { synthetic: gate.promise } });
      const manager = createConnectionManager(authOptions(), { driver: fake.driver });
      const queries = createQueryClient(manager);
      const native = manager.withConnection(async () => {
        started.resolve();
        await gate.promise;
      });
      const running = queries.query("synthetic").catch(() => {});
      await started.promise;
      await vi.waitFor(() => expect(fake.connections[1]?.execute).toHaveBeenCalled());
      let settled = false;
      const closing = queries.close({ timeoutMs: 300 }).finally(() => {
        settled = true;
      });
      const rejected = expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
      // Draining one after the other would take a second grace period.
      await vi.advanceTimersByTimeAsync(310);
      expect(settled).toBe(true);
      await rejected;
      gate.resolve();
      await Promise.allSettled([native, running]);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    [2_000, 300],
    [300, 2_000],
  ])(
    "uses the query client's closeMs (%i ms) for its manager too, not the manager's (%i ms)",
    async (queryCloseMs, managerCloseMs) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const gate = deferred();
        const fake = fakeDriver({ sqlGates: { synthetic: gate.promise } });
        const manager = createConnectionManager(authOptions(), {
          driver: fake.driver,
          timeouts: { closeMs: managerCloseMs },
        });
        const queries = createQueryClient(manager, { timeouts: { closeMs: queryCloseMs } });
        const native = manager.withConnection(() => gate.promise).catch(() => {});
        const running = queries.query("synthetic").catch(() => {});
        await vi.waitFor(() => expect(fake.connections[1]?.execute).toHaveBeenCalled());
        let settled = false;
        const closing = queries.close().finally(() => {
          settled = true;
        });
        const rejected = expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
        await vi.advanceTimersByTimeAsync(queryCloseMs - 50);
        // Neither side gives up before the query client's grace period.
        expect(fake.connections[1]?.cancel).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(true);
        await rejected;
        gate.resolve();
        await Promise.all([native, running]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("closes a shared manager for every query client on it; separate managers stay independent", async () => {
    const fake = fakeDriver();
    const shared = createConnectionManager(authOptions(), { driver: fake.driver });
    const first = createQueryClient(shared);
    const second = createQueryClient(shared);
    await first.close();
    await expect(second.query("synthetic")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await second.close();
    const own = createQueryClient(createConnectionManager(authOptions(), { driver: fake.driver }));
    const other = createQueryClient(
      createConnectionManager(authOptions(), { driver: fake.driver }),
    );
    await own.close();
    await expect(other.query("synthetic")).resolves.toMatchObject({ rowCount: expect.any(Number) });
    await other.close();
  });
});

describe("createSarClient forms", () => {
  const components = () => {
    const auth = authOptions();
    return {
      queryClient: createQueryClient(
        createConnectionManager(auth, { driver: fakeDriver().driver }),
      ),
      fetchClient: createFetchClient(auth),
      secretsClient: createSecretsClient(),
    };
  };
  it("builds every component from one provider, so SQL and fetch share connection options", async () => {
    const client = createSarClient(authOptions());
    await client.asCaller({ token: "alice" }).fetch("/api/v2/test");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers.get("authorization")).toBe(
      "Bearer spcs.synthetic-owner.alice",
    );
    await client.close();
    await expect(client.fetch("/api/v2/test")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("composes supplied components and closes them", async () => {
    const parts = components();
    const client = createSarClient(parts);
    await expect(client.query("synthetic")).resolves.toMatchObject({
      rowCount: expect.any(Number),
    });
    await client.close();
    await expect(parts.queryClient.query("synthetic")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    await expect(parts.secretsClient.getString("KEY")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });
  it.each([
    [
      "extra arguments",
      [authOptions(), { callerAsOwner: true }],
      /createSarClient takes no arguments/,
    ],
    ["null", [null], /createSarClient takes no arguments/],
    ["a string", ["dev"], /createSarClient takes no arguments/],
    ["an array", [[]], /createSarClient takes no arguments/],
    [
      "an empty object",
      [{}],
      /^Missing client components: queryClient, fetchClient, secretsClient$/,
    ],
    [
      "raw native connection options",
      [{ account: "test", authenticator: "OAUTH", token: "synthetic" }],
      /^Unknown client option: account\. createSarClient takes no arguments/,
    ],
    [
      "a connection manager",
      [createConnectionManager(authOptions())],
      /^Unknown client option: \w+\. createSarClient takes no arguments/,
    ],
    [
      "the removed options form",
      [{ connectionOptions: authOptions() }],
      /^Unknown client option: connectionOptions\. createSarClient takes no arguments/,
    ],
  ])("rejects %s with INVALID_OPTIONS", (_name, input, message) => {
    expect(() => (createSarClient as (...args: unknown[]) => unknown)(...input)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", message: expect.stringMatching(message) }),
    );
  });
  it("rejects missing components and components of the wrong kind", () => {
    const auth = authOptions();
    const manager = createConnectionManager(auth, { driver: fakeDriver().driver });
    const invalid = (input: object, message: string) =>
      expect(() => createSarClient(input as never)).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS", message }),
      );
    const { fetchClient, secretsClient } = components();
    invalid({ fetchClient, secretsClient }, "Missing client components: queryClient");
    invalid(
      { queryClient: manager, fetchClient, secretsClient },
      "queryClient must be a client created with createQueryClient(connectionManager)",
    );
    invalid(
      {
        queryClient: createQueryClient(manager.asCaller({ token: "alice" })),
        fetchClient,
        secretsClient,
      },
      "queryClient must be a client created with createQueryClient(connectionManager)",
    );
    invalid(
      { queryClient: createQueryClient(manager), fetchClient: auth, secretsClient },
      "fetchClient must be a client created with createFetchClient()",
    );
    invalid(
      { queryClient: createQueryClient(manager), fetchClient, secretsClient: null },
      "secretsClient must be a client created with createSecretsClient()",
    );
  });
});
