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
  return createConnectionOptions({
    account: "test",
    accessUrl: "https://test.snowflakecomputing.com",
    authenticator: "OAUTH",
    token: "synthetic-owner",
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
    expect(owner).toMatchObject({ authenticator: "OAUTH", token: "synthetic-owner" });
    expect(auth.getCallerOptions("synthetic-caller")).toMatchObject({
      authenticator: "OAUTH",
      token: "synthetic-owner.synthetic-caller",
    });
    expect(auth.getOwnerOptions()).toMatchObject({ token: "synthetic-owner" });
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
            : createSarClient(input);
      input.connectionOptions = undefined;
      await client.close();
      expect(auth.getOwnerOptions()).toHaveProperty("token");
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
    expect(auth.getOwnerOptions().authenticator).toBe("OAUTH");
    await expect(caller.fetch("/api/v2/test")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(secrets.getString("KEY")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => http.asCaller({ token: "test" })).toThrow();
  });
  it("standalone fetch without connection options fails and has idempotent shutdown", async () => {
    const http = createFetchClient();
    await expect(http.fetch("/api/v2/test")).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
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
