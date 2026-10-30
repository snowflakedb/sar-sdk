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
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/connection-options/index.js";
import { nextSteps } from "../src/core/errors.js";
import { fakeDriver } from "./fake-driver.js";
import type { PoolOptions } from "../src/index.js";

const connection = {
  account: "org-account",
  accessUrl: "https://org-account.snowflakecomputing.com",
  authenticator: "OAUTH",
  token: "test-token",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(fakeOptions: Parameters<typeof fakeDriver>[0] = {}, pool?: PoolOptions) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const fake = fakeDriver(fakeOptions);
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: createConnectionOptions(connection),
    ...(pool ? { pool } : {}),
  });
  const view = (user = "alice") =>
    client.asCaller({ headers: new Headers({ "sf-context-current-user-token": user }) });
  const statements = (index: number) =>
    fake.connections[index]!.execute.mock.calls.map(([options]) => {
      const text = String(options.sqlText);
      if (text.startsWith("ALTER SESSION SET")) return "set formats";
      if (text.startsWith("ALTER SESSION UNSET")) return "unset formats";
      return text;
    });
  return { client, ...fake, view, statements };
}
afterEach(() => vi.useRealTimers());

describe("caller session reuse", () => {
  it("runs a view's operations on one session without logging in again", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    await alice.query("SELECT 1");
    for await (const row of await alice.stream("SELECT 2")) expect(row).toBeDefined();
    expect((await (await alice.submit("SELECT 3")).result()).rowCount).toBe(1);
    await alice.withConnection(async () => {});
    expect(connections).toHaveLength(1);
    expect(connections[0]?.connect).toHaveBeenCalledOnce();
    expect(connections[0]?.destroy).not.toHaveBeenCalled();
    expect((await client.diagnostics()).physicalConnections).toBe(0);
    await client.close();
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
  });
  it("keeps working once the caller token can no longer log in", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {};
    const { client, connections, view } = setup(fakeOptions);
    const alice = view();
    await alice.query("SELECT 1");
    fakeOptions.connectError = Object.assign(new Error("synthetic expired token"), {
      code: "390303",
    });
    expect((await alice.query("SELECT 2")).rowCount).toBe(1);
    await expect(view("bob").query("SELECT 3")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(connections.map((connection) => connection.config.token)).toEqual([
      "test-token.alice",
      "test-token.bob",
    ]);
    await client.close();
  });
  it("gives concurrent operations their own sessions and reuses both afterward", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    const run = async () => {
      const gate = deferred();
      const started = deferred();
      const first = alice.withConnection(async (connection) => {
        started.resolve();
        await gate.promise;
        return connection;
      });
      // Otherwise the pool may hand the second operation's returned session to the first.
      await started.promise;
      const second = alice.withConnection(async (connection) => connection);
      const other = await second;
      gate.resolve();
      return [await first, other];
    };
    const [a, b] = await run();
    expect(a).not.toBe(b);
    expect(new Set(await run())).toEqual(new Set([a, b]));
    expect(connections).toHaveLength(2);
    expect(connections.every((connection) => connection.connect.mock.calls.length === 1)).toBe(
      true,
    );
    await client.close();
  });
  it("retires a session after a failed operation and logs it out with the view", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    const failure = new Error("synthetic application failure");
    await expect(
      alice.withConnection(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await alice.query("SELECT 1");
    await alice.query("SELECT 2");
    expect(connections).toHaveLength(2);
    expect(connections.map((connection) => connection.destroy.mock.calls.length)).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections.map((connection) => connection.destroy.mock.calls.length)).toEqual([1, 1]);
    await client.close();
  });
  it("retires a session left before its stream ended", async () => {
    const { client, connections, view } = setup({ rows: [["1"], ["2"]] });
    const alice = view();
    for await (const row of await alice.stream("SELECT 1")) {
      expect(row).toEqual({ VALUE: "1" });
      break;
    }
    await alice.query("SELECT 2");
    expect(connections).toHaveLength(2);
    await client.close();
  });
  it("reuses sessions only within the same view and warehouse", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    await alice.query("SELECT 1", { warehouse: "A_WH" });
    await alice.query("SELECT 2", { warehouse: "B_WH" });
    await alice.query("SELECT 3", { warehouse: "A_WH" });
    await view().query("SELECT 4", { warehouse: "A_WH" });
    expect(connections.map((connection) => connection.config.warehouse)).toEqual([
      "A_WH",
      "B_WH",
      "A_WH",
    ]);
    await client.close();
  });
  it("keeps a fresh session for each owner operation", async () => {
    const { client, connections } = setup();
    await client.query("SELECT 1");
    await client.query("SELECT 2");
    expect(connections).toHaveLength(2);
    expect(connections.map((connection) => connection.destroy.mock.calls.length)).toEqual([1, 1]);
    await client.close();
  });
  it("sets JSON output formats once per session and unsets them for native results", async () => {
    const { client, view, statements } = setup();
    const alice = view();
    await alice.query("SELECT 1");
    await alice.query("SELECT 2");
    await alice.query("SELECT 3", { format: "native" });
    await alice.query("SELECT 4", { format: "native" });
    await alice.query("SELECT 5");
    expect(statements(0)).toEqual([
      "set formats",
      "SELECT 1",
      "SELECT 2",
      "unset formats",
      "SELECT 3",
      "SELECT 4",
      "set formats",
      "SELECT 5",
    ]);
    await client.close();
  });
  it("sets formats again after an application reset hook runs", async () => {
    const reset = vi.fn(async () => {});
    const { client, connections, statements } = setup({}, { mode: "reusable", reset });
    await client.query("SELECT 1");
    await client.query("SELECT 2");
    expect(connections).toHaveLength(1);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(statements(0)).toEqual(["set formats", "SELECT 1", "set formats", "SELECT 2"]);
    await client.close();
  });
  it("logs in again after the view's sessions were logged out", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    await alice.query("SELECT 1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections[0]?.destroy).toHaveBeenCalledOnce();
    await alice.query("SELECT 2");
    expect(connections).toHaveLength(2);
    await client.close();
  });
});

describe("caller transactions", () => {
  const open = {
    code: "INVALID_OPTIONS",
    details: { nextStep: nextSteps.callerTransactionOpen },
  };

  it("refuses other SQL for the same caller context while a transaction is open", async () => {
    const { client, connections, view } = setup();
    const alice = view();
    const sameCaller = view();
    const opened = deferred();
    const finish = deferred();
    const transaction = alice.transaction(async (tx) => {
      await tx.query("SELECT 1");
      opened.resolve();
      await finish.promise;
      return (await tx.query("SELECT 2")).rowCount;
    });
    await opened.promise;
    const logins = connections.length;
    await expect(alice.query("SELECT 3")).rejects.toMatchObject(open);
    await expect(sameCaller.query("SELECT 4")).rejects.toMatchObject(open);
    await expect(sameCaller.stream("SELECT 5")).rejects.toMatchObject(open);
    await expect(sameCaller.submit("SELECT 6")).rejects.toMatchObject(open);
    await expect(sameCaller.withConnection(async () => {})).rejects.toMatchObject(open);
    await expect(sameCaller.submitDetached("SELECT 7")).rejects.toMatchObject(open);
    await expect(sameCaller.transaction(async () => {})).rejects.toMatchObject(open);
    expect(connections).toHaveLength(logins);
    finish.resolve();
    await expect(transaction).resolves.toBe(1);
    expect((await sameCaller.query("SELECT 8")).rowCount).toBe(1);
    await client.close();
  });
  it("refuses to start a caller transaction while other work for that caller runs", async () => {
    const { client, view } = setup({ rows: [["1"], ["2"]] });
    const alice = view();
    const running = {
      code: "INVALID_OPTIONS",
      details: { nextStep: nextSteps.callerWorkRunning },
    };
    const stream = await alice.stream("SELECT 1");
    await expect(view().transaction(async () => {})).rejects.toMatchObject(running);
    await stream.close();
    const held = deferred();
    const callback = alice.withConnection(async () => held.promise);
    await expect(alice.transaction(async () => {})).rejects.toMatchObject(running);
    held.resolve();
    await callback;
    await expect(
      alice.transaction(async (tx) => (await tx.query("SELECT 2")).rowCount),
    ).resolves.toBe(2);
    await client.close();
  });
  it("leaves other callers, the owner, and owner-mode views unaffected", async () => {
    const { client, view } = setup();
    const opened = deferred();
    const finish = deferred();
    const transaction = view("alice").transaction(async () => {
      opened.resolve();
      await finish.promise;
    });
    await opened.promise;
    expect((await view("bob").query("SELECT 1")).rowCount).toBe(1);
    expect((await client.query("SELECT 2")).rowCount).toBe(1);
    await client.transaction(async (tx) => tx.query("SELECT 3"));
    await view("bob").transaction(async (tx) => tx.query("SELECT 4"));
    finish.resolve();
    await transaction;
    await client.close();

    const fake = fakeDriver();
    const asOwner = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(connection, { callerAsOwner: true }),
    });
    const ownerView = () =>
      asOwner.asCaller({ headers: new Headers({ "sf-context-current-user-token": "alice" }) });
    const inside = deferred();
    const done = deferred();
    const ownerTransaction = ownerView().transaction(async () => {
      inside.resolve();
      await done.promise;
    });
    await inside.promise;
    expect((await ownerView().query("SELECT 5")).rowCount).toBe(1);
    done.resolve();
    await ownerTransaction;
    await asOwner.close();
  });
  it("releases the caller context after a transaction fails, rolls back, or can't log in", async () => {
    const fakeOptions: Parameters<typeof fakeDriver>[0] = {
      sqlErrors: { BEGIN: new Error("synthetic begin failure") },
    };
    const { client, view } = setup(fakeOptions);
    const alice = view();
    await expect(alice.transaction(async () => {})).rejects.toMatchObject({
      code: "QUERY_FAILED",
      details: { completion: "not-submitted" },
    });
    fakeOptions.sqlErrors = {};
    const failure = new Error("synthetic application failure");
    await expect(
      alice.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    fakeOptions.connectError = new Error("synthetic login failure");
    await expect(view().transaction(async () => {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    fakeOptions.connectError = undefined;
    expect((await view().query("SELECT 1")).rowCount).toBe(1);
    await expect(
      view().transaction(async (tx) => (await tx.query("SELECT 2")).rowCount),
    ).resolves.toBe(1);
    await client.close();
  });
});
