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

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnectionOptions, fromCredentials, fromToml } from "../src/auth.js";
import { mounts, profileFields } from "../src/config.js";
import { createSarClient } from "../src/index.js";
import type { LogEvent, SarClientOptions } from "../src/types.js";
import { fakeDriver } from "./fake-driver.js";

// Keep platform detection synthetic; profiles come only from the temporary SNOWFLAKE_HOME.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async (filename: string) => {
      if (Object.values(mounts).includes(filename))
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return actual.access(filename);
    }),
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-profile-keys-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
  vi.stubEnv("CI", "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const known = [
  'account = "dev-account"',
  'user = "developer"',
  'authenticator = "oauth"',
  'token = "synthetic-token"',
];
// Out of order, so reports must sort them.
const unknown = [
  'other_tool = { profile = "unused-value-marker" }',
  'workspace = "unused-value-marker"',
  "oauth_enable_refresh_tokens = true",
  "client_session_keep_alive = true",
];
const ignored = [
  "client_session_keep_alive",
  "oauth_enable_refresh_tokens",
  "other_tool",
  "workspace",
];
const profile = (...lines: string[]) =>
  writeFile(path.join(directory, "connections.toml"), ["[dev]", ...lines].join("\n"), {
    mode: 0o600,
  });
function profileClient() {
  const fake = fakeDriver();
  const logger = vi.fn();
  const client = createSarClient({ driver: fake.driver, connection: { name: "dev" }, logger });
  return { client, fake, logger };
}
const events = (logger: Mock<(event: LogEvent) => unknown>) =>
  logger.mock.calls.map(([event]) => event.event);

describe("profile keys the SDK doesn't use", () => {
  it("connects with the keys it uses and skips the rest", async () => {
    await profile(...unknown, ...known);
    const { client, fake } = profileClient();
    try {
      await client.connect();
      expect(fake.connections[0]?.config).toEqual({
        account: "dev-account",
        accessUrl: "https://dev-account.snowflakecomputing.com",
        username: "developer",
        authenticator: "OAUTH",
        token: "synthetic-token",
        application: "SnowflakeAppRuntime",
        clientSessionKeepAlive: false,
        serverSessionKeepAlive: false,
      });
    } finally {
      await client.close();
    }
  });

  it("reports the skipped names once the profile is resolved, never their values", async () => {
    await profile(...unknown, ...known);
    const { client, logger } = profileClient();
    try {
      expect(await client.diagnostics()).not.toHaveProperty("ignoredProfileKeys");
      await client.connect();
      await client.query("SELECT 1");
      const diagnostics = await client.diagnostics();
      expect(diagnostics).toMatchObject({ connectionName: "dev", ignoredProfileKeys: ignored });
      expect(events(logger)).toEqual([
        "profile-keys-ignored",
        "session-opened",
        "session-opened",
        "query-succeeded",
      ]);
      expect(logger).toHaveBeenNthCalledWith(1, { event: "profile-keys-ignored", keys: ignored });
      const reported = JSON.stringify([diagnostics, logger.mock.calls]);
      for (const value of ["unused-value-marker", "synthetic-token", directory])
        expect(reported).not.toContain(value);
      diagnostics.ignoredProfileKeys?.pop();
      expect((await client.diagnostics()).ignoredProfileKeys).toEqual(ignored);
    } finally {
      await client.close();
    }
  });

  it("reports through a standalone factory for a config.toml profile", async () => {
    await writeFile(
      path.join(directory, "config.toml"),
      ["[connections.dev]", ...unknown, ...known].join("\n"),
      { mode: 0o600 },
    );
    const logger = vi.fn();
    const options = createConnectionOptions(fromToml({ name: "dev" }), { logger });
    try {
      expect(await options.diagnostics()).not.toHaveProperty("ignoredProfileKeys");
      expect(await options.getOwnerOptions()).toMatchObject({
        account: "dev-account",
        token: "synthetic-token",
      });
      await options.getOwnerOptions();
      expect(await options.diagnostics()).toMatchObject({
        connectionName: "dev",
        ignoredProfileKeys: ignored,
      });
      expect(logger).toHaveBeenCalledExactlyOnceWith({
        event: "profile-keys-ignored",
        keys: ignored,
      });
    } finally {
      await options.close();
    }
  });

  it("keeps the selected profile when the logger throws", async () => {
    await profile(...unknown, ...known);
    const fake = fakeDriver();
    const logger = vi.fn(() => {
      throw new Error("synthetic logger failure");
    });
    const client = createSarClient({ driver: fake.driver, connection: { name: "dev" }, logger });
    try {
      await client.connect();
      await client.connect();
      expect(events(logger)).toEqual(["profile-keys-ignored", "session-opened", "session-opened"]);
      expect(fake.connections).toHaveLength(2);
      expect((await client.diagnostics()).ignoredProfileKeys).toEqual(ignored);
    } finally {
      await client.close();
    }
  });

  it("keeps the selected profile when an async logger rejects", async () => {
    await profile(...unknown, ...known);
    const fake = fakeDriver();
    const seen: LogEvent[] = [];
    // Not vi.fn(): a mock observes the promises it returns, which handles their rejections.
    const logger = async (event: LogEvent) => {
      seen.push(event);
      throw new Error("synthetic logger failure");
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const client = createSarClient({ driver: fake.driver, connection: { name: "dev" }, logger });
    try {
      await client.connect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen[0]).toEqual({ event: "profile-keys-ignored", keys: ignored });
      expect(fake.connections).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await client.close();
    }
  });

  it("treats keys named after object built-ins as unused", async () => {
    await profile(
      ...known,
      'constructor = "unused-value-marker"',
      '__proto__ = "unused-value-marker"',
    );
    expect(await profileFields({ name: "dev" })).toEqual({
      account: "dev-account",
      username: "developer",
      authenticator: "oauth",
      token: "synthetic-token",
    });
    const { client } = profileClient();
    try {
      await client.connect();
      expect((await client.diagnostics()).ignoredProfileKeys).toEqual(["__proto__", "constructor"]);
    } finally {
      await client.close();
    }
  });

  it("reports nothing for a profile without skipped keys", async () => {
    await profile(...known);
    const { client, logger } = profileClient();
    try {
      await client.connect();
      const diagnostics = await client.diagnostics();
      expect(diagnostics).toMatchObject({
        connectionName: "dev",
        providers: [{ id: "profile", state: "selected" }],
      });
      expect(diagnostics).not.toHaveProperty("ignoredProfileKeys");
      expect(events(logger)).toEqual(["session-opened"]);
    } finally {
      await client.close();
    }
  });

  it.each([
    ["port = true", "port must be a string or number"],
    ['warehouse = ["APP_WH"]', "warehouse must be a string or number"],
    [
      'client_store_temporary_credential = "sometimes"',
      "client_store_temporary_credential must be a boolean",
    ],
  ])("still rejects a wrong type for a key it uses: %s", async (line, message) => {
    await profile(...unknown, ...known, line);
    await expect(profileFields({ name: "dev" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message,
    });
  });

  it("still rejects region, and reports nothing for the rejected profile", async () => {
    await profile(...unknown, ...known, 'region = "eu-west-1"');
    await expect(profileFields({ name: "dev" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("region-qualified account"),
    });
    const { client, fake, logger } = profileClient();
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(await client.diagnostics()).not.toHaveProperty("ignoredProfileKeys");
      expect(logger).not.toHaveBeenCalled();
      expect(fake.connections).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("still rejects conflicting identities", async () => {
    await profile(...unknown, ...known);
    await expect(profileFields({ name: "dev", account: "other-account" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message:
        "Connection account conflicts across configuration sources. Select a matching source instead.",
    });
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEV_USER", "another-user");
    await expect(profileFields({ name: "dev" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message:
        "Connection username conflicts across configuration sources. Select a matching source instead.",
    });
  });

  it.skipIf(process.platform === "win32")("still requires a private profile file", async () => {
    await profile(...unknown, ...known);
    await chmod(path.join(directory, "connections.toml"), 0o644);
    await expect(profileFields({ name: "dev" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message:
        "Snowflake configuration must not be accessible by other users; set file permissions to 0600",
    });
  });

  it("still rejects unknown fields in options supplied in code", async () => {
    await profile(...unknown, ...known);
    const connection = { name: "dev", oauth_enable_refresh_tokens: true };
    for (const create of [
      () => createSarClient({ connection } as unknown as SarClientOptions),
      () => createConnectionOptions(undefined, { connection } as never),
    ])
      expect(create).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "Unknown connection option: oauth_enable_refresh_tokens",
        }),
      );
    const unsupported = {
      code: "CONFIG_INVALID",
      message: "Unsupported connection target field: oauth_enable_refresh_tokens",
    };
    await expect(profileFields(connection as never)).rejects.toMatchObject(unsupported);
    expect(() =>
      fromCredentials({
        target: { account: "dev-account", oauth_enable_refresh_tokens: true } as never,
        credential: { type: "oauth", token: "synthetic-token" },
      }),
    ).toThrow(expect.objectContaining(unsupported));
  });
});
