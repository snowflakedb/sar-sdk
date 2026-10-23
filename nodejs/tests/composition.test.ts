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
import { createConnectionOptions } from "../src/auth.js";
import { createConnectionManager } from "../src/connections.js";
import { createQueryClient } from "../src/queries.js";
import { createFetchClient } from "../src/account-http.js";
import { createSecrets } from "../src/secret-client.js";
import { createSarClient } from "../src/index.js";
import type { ConnectionManagerOptions } from "../src/types.js";
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
  return createConnectionOptions(
    [
      {
        id: "test",
        async resolve() {
          return {
            target: { account: "test" },
            platform: "spcs",
            async acquire() {
              return { type: "oauth", token: "synthetic-owner" };
            },
          };
        },
      },
    ],
    { environment: "deployed", platform: "spcs" },
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("independent authentication", () => {
  it("allows an explicit credential deadline to override the default", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const auth = createConnectionOptions(
      [
        {
          id: "test",
          async resolve() {
            return {
              target: { account: "test" },
              async acquire() {
                await gate.promise;
                return { type: "oauth", token: "synthetic" };
              },
            };
          },
        },
      ],
      { authTimeoutMs: 5 },
    );
    try {
      const pending = auth.getOwnerOptions({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(10);
      gate.resolve();
      await expect(pending).resolves.toHaveProperty("token");
    } finally {
      await auth.close();
      vi.useRealTimers();
    }
  });
  it("resolves detached credentials repeatedly without SQL and isolates caller scopes", async () => {
    const auth = authOptions();
    expect((await auth.diagnostics()).providers[0]?.state).toBe("unprobed");
    const context = {
      headers: new Headers({ "sf-context-current-user-token": "synthetic-caller" }),
    };
    const owner = await auth.getOwnerOptions();
    expect(owner).toMatchObject({ authenticator: "OAUTH", token: "synthetic-owner" });
    expect(await auth.getCallerOptions(context)).toMatchObject({
      authenticator: "OAUTH",
      token: "synthetic-owner.synthetic-caller",
    });
    expect((await auth.diagnostics()).providers[0]?.state).toBe("selected");
    await auth.close();
    await expect(auth.getOwnerOptions()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(auth.getCallerOptions(context)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("rejects pre-aborted acquisition without probing sources", async () => {
    const resolve = vi.fn();
    const auth = createConnectionOptions([{ id: "test", resolve }]);
    await expect(auth.getOwnerOptions({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(resolve).not.toHaveBeenCalled();
    await auth.close();
  });
  it("aborts credential waits on close", async () => {
    const gate = deferred();
    const auth = createConnectionOptions([
      {
        id: "test",
        async resolve() {
          await gate.promise;
          return undefined;
        },
      },
    ]);
    const pending = auth.getOwnerOptions();
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await auth.close();
    await rejected;
    gate.resolve();
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
            : createSarClient(input);
      input.connectionOptions = undefined;
      await client.close();
      await expect(auth.getOwnerOptions()).resolves.toHaveProperty("token");
      await auth.close();
    },
  );
  it("HTTP and secrets work without a driver or SQL-capable client", async () => {
    const auth = authOptions();
    const http = createFetchClient(auth);
    const secrets = createSecrets({
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
      "Bearer synthetic-owner.synthetic-caller",
    );
    await Promise.all([http.close(), secrets.close()]);
    expect((await auth.getOwnerOptions()).authenticator).toBe("OAUTH");
    await expect(caller.fetch("/api/v2/test")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(secrets.getString("KEY")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => http.asCaller({ token: "test" })).toThrow();
    await auth.close();
  });
  it("standalone fetch owns its resolver and has idempotent shutdown", async () => {
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "test");
    vi.stubEnv("SNOWFLAKE_AUTHENTICATOR", "oauth");
    vi.stubEnv("SNOWFLAKE_TOKEN", "synthetic");
    vi.stubEnv("SNOWFLAKE_CONNECTION_NAME", undefined);
    vi.stubEnv("SNOWFLAKE_DEFAULT_CONNECTION_NAME", undefined);
    const http = createFetchClient();
    expect(await (await http.fetch("/api/v2/test")).text()).toBe("ok");
    const closing = http.close();
    expect(http.close()).toBe(closing);
    await closing;
  });
  it("query clients borrow a manager and only cancel their own leases", async () => {
    const fake = fakeDriver({ status: "RUNNING" });
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const first = createQueryClient(manager);
    const second = createQueryClient(manager);
    const handle = await first.submit("synthetic");
    await expect(first.close({ timeoutMs: 1 })).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await expect(handle.result()).rejects.toMatchObject({ code: "ABORTED" });
    await manager.withConnection(async (connection) => {
      expect(connection.execute).toBe(fake.connections[1]?.execute);
    });
    const other = await second.submit("synthetic");
    await other.cancel();
    await second.close();
    await manager.close();
  });
  it("scoped queries cannot select an owner or caller identity", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const scoped = createQueryClient(manager.asCaller({ token: "synthetic-caller" }));
    expect("asCaller" in scoped).toBe(false);
    await scoped.query("synthetic");
    expect(fake.connections[0]?.config.token).toBe("synthetic-owner.synthetic-caller");
    await scoped.close();
    await manager.close();
  });
  it("query helper asCaller uses its parent shutdown and preserves native access", async () => {
    const fake = fakeDriver();
    const manager = createConnectionManager(authOptions(), { driver: fake.driver });
    const queries = createQueryClient(manager);
    const caller = queries.asCaller({ token: "synthetic-caller" });
    await caller.query("synthetic");
    await queries.close();
    await expect(caller.query("synthetic")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => queries.asCaller({ token: "another" })).toThrow();
    await manager.connect();
    await manager.close();
    expect(() => manager.asCaller({ token: "test" })).toThrow();
  });
  it("query close can wait for an existing operation without closing its manager", async () => {
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
    await manager.connect();
    await manager.close();
  });
  it("query close aborts pending admission, not another client's operation", async () => {
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
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await expect(queries.close({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "SHUTDOWN_TIMEOUT",
    });
    await rejected;
    expect(fake.connections[0]?.destroy).not.toHaveBeenCalled();
    gate.resolve();
    await work;
    await manager.close();
  });
  it("aggregate borrows supplied auth and snapshots stateful headers exactly once", async () => {
    const fake = fakeDriver();
    const auth = authOptions();
    const client = createSarClient({ connectionOptions: auth, driver: fake.driver });
    const get = vi.fn().mockReturnValueOnce("synthetic-first").mockReturnValue("synthetic-other");
    const caller = client.asCaller({ headers: { get } });
    await caller.query("synthetic");
    await caller.fetch("/api/v2/test");
    expect(get).toHaveBeenCalledOnce();
    expect(fake.connections[0]?.config.token).toBe("synthetic-owner.synthetic-first");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers.get("authorization")).toBe(
      "Bearer synthetic-owner.synthetic-first",
    );
    await client.close();
    await auth.getOwnerOptions();
    await auth.close();
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
      "synthetic-owner.synthetic-caller",
      "synthetic-owner",
    ]);
    await manager.close();
  });
  it.each(["query", "fetch", "secrets"])("connection options reject unrelated %s", (key) => {
    expect(() =>
      createConnectionManager(undefined, { [key]: {} } as ConnectionManagerOptions),
    ).toThrow();
  });
});
