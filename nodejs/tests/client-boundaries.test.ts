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
import { createConnectionOptions } from "../src/auth.js";
import { fakeDriver } from "./fake-driver.js";

describe("integrated client boundaries", () => {
  it("normalizes a failing options provider at connect without leaking its message", async () => {
    const marker = "synthetic-private-provider-message";
    const cause = new Error(marker);
    const client = createSarClient({
      connectionOptions: {
        getOwnerOptions() {
          throw cause;
        },
        getCallerOptions() {
          throw cause;
        },
      },
    });
    try {
      const error = await client.connect().catch((error) => error);
      expect(error).toMatchObject({ code: "AUTH_FAILED", cause });
      expect(JSON.stringify(error)).not.toContain(marker);
    } finally {
      await client.close();
    }
  });
  it("passes a provider's SarError through connect and fetch", async () => {
    const cause = new SarError("AUTH_FAILED", "synthetic provider failure");
    const client = createSarClient({
      connectionOptions: {
        getOwnerOptions() {
          throw cause;
        },
        getCallerOptions() {
          throw cause;
        },
      },
    });
    try {
      for (const operation of [() => client.connect(), () => client.fetch("/api/v2/test")])
        await expect(operation()).rejects.toBe(cause);
    } finally {
      await client.close();
    }
  });
  it("normalizes REST option errors without leaking provider messages", async () => {
    const marker = "synthetic-private-provider-message";
    const client = createSarClient({
      connectionOptions: {
        getOwnerOptions() {
          throw Error(marker);
        },
        getCallerOptions() {
          throw Error(marker);
        },
      },
    });
    const error = await client.fetch("/api/v2/test").catch((error) => error);
    expect(error).toBeInstanceOf(SarError);
    expect(JSON.stringify(error)).not.toContain(marker);
    await client.close();
  });
  it("does not expose invalid configured URLs in errors", async () => {
    const client = createSarClient({
      driver: fakeDriver().driver,
      connectionOptions: createConnectionOptions({
        account: "test",
        accessUrl: "https://user:synthetic-secret@example.invalid/?sensitive",
      }),
    });
    const failures = await Promise.all([
      client.connect().catch((error) => error),
      client.fetch("/api/v2/test").catch((error) => error),
    ]);
    for (const error of failures) {
      expect(error).toBeInstanceOf(SarError);
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
      expect(String(error.message)).not.toContain("synthetic-secret");
    }
    expect(JSON.stringify(await client.diagnostics())).not.toContain("synthetic-secret");
    await client.close();
  });
  it("rejects pre-aborted REST before reading connection options", async () => {
    const getOwnerOptions = vi.fn();
    const client = createSarClient({
      connectionOptions: { getOwnerOptions, getCallerOptions: vi.fn() },
    });
    await expect(
      client.fetch("/api/v2/test", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(getOwnerOptions).not.toHaveBeenCalled();
    await client.close();
  });
  it("fails work that needs a connection without connection options", async () => {
    const client = createSarClient({ driver: fakeDriver().driver });
    await expect(client.connect()).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
    await expect(client.fetch("/api/v2/test")).rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
    await client.close();
  });
  it("does not expose the internal secrets disposal hook", async () => {
    const client = createSarClient({ connectionOptions: createConnectionOptions({}) });
    expect(Object.keys(client.secrets).sort()).toEqual([
      "getAccessToken",
      "getPassword",
      "getString",
    ]);
    await client.close();
    await expect(client.secrets.getString("TEST")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
});
