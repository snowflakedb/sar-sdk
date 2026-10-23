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

import { describe, expect, it, vi } from "vitest";
import { createSarClient, SarError } from "../src/index.js";
import { createConnectionOptions, fromCredentials, type AuthProvider } from "../src/auth.js";
import { fakeDriver } from "./fake-driver.js";

describe("integrated client boundaries", () => {
  it.each(["resolve", "acquire"] as const)(
    "normalizes provider SarError at %s without fallback",
    async (phase) => {
      const marker = "synthetic-provider-diagnostic";
      const cause = new SarError("AUTH_FAILED", marker, { nextStep: marker });
      const fallback = vi.fn();
      const client = createSarClient({
        connectionOptions: createConnectionOptions(
          [
            {
              id: "test",
              async resolve() {
                if (phase === "resolve") throw cause;
                return {
                  target: { account: "test" },
                  async acquire() {
                    throw cause;
                  },
                };
              },
            },
            { id: "fallback", resolve: fallback },
          ],
          { environment: "local" },
        ),
      });
      try {
        for (const operation of [() => client.connect(), () => client.fetch("/api/v2/test")]) {
          const error = await operation().catch((error) => error);
          expect(error).toMatchObject({ code: "AUTH_FAILED", cause });
          expect(JSON.stringify(error)).not.toContain(marker);
        }
        expect(fallback).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );
  it("aborts REST credential waiting while SQL remains inside the shutdown grace period", async () => {
    let releaseSql!: () => void;
    let sqlStarted!: () => void;
    let credentialStarted!: () => void;
    let resolveCredential!: (value: { type: "oauth"; token: string }) => void;
    const sqlGate = new Promise<void>((resolve) => {
      releaseSql = resolve;
    });
    const started = new Promise<void>((resolve) => {
      sqlStarted = resolve;
    });
    const acquiring = new Promise<void>((resolve) => {
      credentialStarted = resolve;
    });
    let acquisitions = 0;
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions([
        {
          id: "test",
          async resolve() {
            return {
              target: { account: "test" },
              async acquire() {
                if (acquisitions++ === 0) return { type: "oauth", token: "synthetic" };
                credentialStarted();
                return new Promise((resolve) => {
                  resolveCredential = resolve;
                });
              },
            };
          },
        },
      ]),
    });
    const sql = client.withConnection(async () => {
      sqlStarted();
      await sqlGate;
    });
    await started;
    const rest = client.fetch("/api/v2/test");
    const rejected = expect(rest).rejects.toMatchObject({ code: "ABORTED" });
    await acquiring;
    const closing = client.close();
    try {
      await rejected;
      expect(fake.connections[0]?.destroy).not.toHaveBeenCalled();
    } finally {
      releaseSql();
      resolveCredential({ type: "oauth", token: "synthetic" });
      await sql;
      await closing;
    }
  });
  it("lets explicit credential-cache opt-out override a provider recipe", async () => {
    const fake = fakeDriver();
    const client = createSarClient({
      driver: fake.driver,
      connectionOptions: createConnectionOptions(
        [
          fromCredentials({
            target: { account: "test", username: "synthetic" },
            credential: {
              type: "driver",
              options: {
                authenticator: "SNOWFLAKE",
                password: "synthetic",
                clientStoreTemporaryCredential: true,
                clientRequestMFAToken: true,
                credentialCacheDir: "/ignored-cache",
              },
            },
          }),
        ],
        {
          driverOptions: {
            clientStoreTemporaryCredential: false,
            clientRequestMFAToken: false,
            credentialCacheDir: "/synthetic-cache",
          },
        },
      ),
    });
    await client.connect();
    expect(fake.connections[0]?.config).toMatchObject({
      clientStoreTemporaryCredential: false,
      clientRequestMFAToken: false,
      credentialCacheDir: "/synthetic-cache",
    });
    await client.close();
  });
  it("does not expose invalid configured URLs in diagnostics", async () => {
    const client = createSarClient({
      connectionOptions: createConnectionOptions([], {
        connection: { accessUrl: "https://user:synthetic-secret@example.invalid/?sensitive" },
      }),
    });
    const diagnostics = await client.diagnostics();
    expect(diagnostics.endpoint).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("synthetic-secret");
    await client.close();
  });
  it("normalizes REST credential errors without leaking provider messages", async () => {
    const provider: AuthProvider = {
      id: "test",
      async resolve() {
        throw Error("synthetic-private-provider-message");
      },
    };
    const client = createSarClient({ connectionOptions: createConnectionOptions([provider]) });
    const error = await client.fetch("/api/v2/test").catch((error) => error);
    expect(error.code).toBe("AUTH_FAILED");
    expect(JSON.stringify(error)).not.toContain("synthetic-private-provider-message");
    await client.close();
  });
  it("rejects pre-aborted REST before resolving credentials", async () => {
    const resolve = vi.fn();
    const client = createSarClient({
      connectionOptions: createConnectionOptions([{ id: "test", resolve }]),
    });
    await expect(
      client.fetch("/api/v2/test", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(resolve).not.toHaveBeenCalled();
    await client.close();
  });
  it("does not expose the internal secrets disposal hook", async () => {
    const client = createSarClient({ connectionOptions: createConnectionOptions([]) });
    expect(Object.keys(client.secrets).sort()).toEqual([
      "getAccessToken",
      "getPassword",
      "getString",
    ]);
    await client.close();
    await expect(client.secrets.getString("TEST")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
});
