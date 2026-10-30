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
import { createConnectionOptions, fromToml } from "../src/connection-options/index.js";
import { profileFields } from "../src/connection-options/config.js";
import { createSarClient } from "../src/index.js";
import type { LogEvent, SarClientOptions } from "../src/index.js";
import { fakeDriver } from "./fake-driver.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-profile-keys-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("SNOWFLAKE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("SNOWFLAKE_HOME", directory);
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
const unknown = [
  'other_tool = { profile = "unused-value-marker" }',
  'workspace = "unused-value-marker"',
  "oauth_enable_refresh_tokens = true",
  "client_session_keep_alive = true",
];
const profile = (...lines: string[]) =>
  writeFile(path.join(directory, "connections.toml"), ["[dev]", ...lines].join("\n"), {
    mode: 0o600,
  });
function profileClient() {
  const fake = fakeDriver();
  const logger = vi.fn();
  const client = createSarClient({
    driver: fake.driver,
    connectionOptions: createConnectionOptions(fromToml({ name: "dev" })),
    logger,
  });
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
        authenticator: "oauth",
        token: "synthetic-token",
        application: "SnowflakeAppRuntime",
        clientSessionKeepAlive: false,
        serverSessionKeepAlive: false,
      });
    } finally {
      await client.close();
    }
  });

  it("skips them silently, without reporting their names or values", async () => {
    await profile(...unknown, ...known);
    const { client, logger } = profileClient();
    try {
      expect(await client.diagnostics()).not.toHaveProperty("ignoredProfileKeys");
      await client.connect();
      await client.query("SELECT 1");
      const diagnostics = await client.diagnostics();
      expect(diagnostics).not.toHaveProperty("ignoredProfileKeys");
      expect(events(logger)).toEqual(["session-opened", "session-opened", "query-succeeded"]);
      const reported = JSON.stringify([diagnostics, logger.mock.calls]);
      for (const value of [
        "unused-value-marker",
        "other_tool",
        "workspace",
        "oauth_enable_refresh_tokens",
        "synthetic-token",
        directory,
      ])
        expect(reported).not.toContain(value);
    } finally {
      await client.close();
    }
  });

  it("skips them for a config.toml profile", async () => {
    await writeFile(
      path.join(directory, "config.toml"),
      ["[connections.dev]", ...unknown, ...known].join("\n"),
      { mode: 0o600 },
    );
    const options = createConnectionOptions(fromToml({ name: "dev" }));
    expect(options.getOwnerOptions()).toEqual({
      account: "dev-account",
      accessUrl: "https://dev-account.snowflakecomputing.com",
      username: "developer",
      authenticator: "oauth",
      token: "synthetic-token",
      application: "SnowflakeAppRuntime",
      clientSessionKeepAlive: false,
      serverSessionKeepAlive: false,
    });
  });

  it("treats keys named after object built-ins as unused", async () => {
    await profile(
      ...known,
      'constructor = "unused-value-marker"',
      '__proto__ = "unused-value-marker"',
    );
    const expected = {
      account: "dev-account",
      username: "developer",
      authenticator: "oauth",
      token: "synthetic-token",
    };
    expect(profileFields({ name: "dev" })).toEqual(expected);
    expect(fromToml({ name: "dev" })).toEqual({
      ...expected,
      accessUrl: "https://dev-account.snowflakecomputing.com",
    });
    const { client, fake } = profileClient();
    try {
      await client.connect();
      expect(JSON.stringify(fake.connections[0]?.config)).not.toContain("unused-value-marker");
    } finally {
      await client.close();
    }
  });

  it("logs only session events for a profile without skipped keys", async () => {
    await profile(...known);
    const { client, logger } = profileClient();
    try {
      await client.connect();
      expect(await client.diagnostics()).not.toHaveProperty("ignoredProfileKeys");
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
    for (const read of [() => profileFields({ name: "dev" }), () => fromToml({ name: "dev" })])
      expect(read).toThrow(expect.objectContaining({ code: "CONFIG_INVALID", message }));
  });

  it("still rejects region, before any client or connection exists", async () => {
    await profile(...unknown, ...known, 'region = "eu-west-1"');
    const unsupported = {
      code: "CONFIG_INVALID",
      message: expect.stringContaining("region-qualified account"),
    };
    expect(() => profileFields({ name: "dev" })).toThrow(expect.objectContaining(unsupported));
    expect(() => fromToml({ name: "dev" })).toThrow(expect.objectContaining(unsupported));
  });

  it("takes no overlays, so environment and explicit values can't conflict with the profile", async () => {
    await profile(...unknown, ...known);
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "other-account");
    vi.stubEnv("SNOWFLAKE_USER", "another-user");
    vi.stubEnv("SNOWFLAKE_CONNECTIONS_DEV_USER", "another-user");
    expect(fromToml({ name: "dev" })).toMatchObject({
      account: "dev-account",
      username: "developer",
    });
    expect(() => fromToml({ name: "dev", account: "other-account" } as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Unknown TOML source option: account",
      }),
    );
  });

  it.skipIf(process.platform === "win32")("still requires a private profile file", async () => {
    await profile(...unknown, ...known);
    await chmod(path.join(directory, "connections.toml"), 0o644);
    const message =
      "Snowflake configuration must not be accessible by other users; set file permissions to 0600";
    for (const read of [() => profileFields({ name: "dev" }), () => fromToml({ name: "dev" })])
      expect(read).toThrow(expect.objectContaining({ code: "CONFIG_INVALID", message }));
  });

  it("still rejects unknown fields in options supplied in code", async () => {
    await profile(...unknown, ...known);
    const connection = { name: "dev", oauth_enable_refresh_tokens: true };
    // The profile selector and the client options are checked; only a profile skips unused keys.
    expect(() => fromToml(connection as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Unknown TOML source option: oauth_enable_refresh_tokens",
      }),
    );
    for (const create of [
      () => createSarClient({ connection } as unknown as SarClientOptions),
      () => createConnectionOptions(fromToml({ name: "dev" }), { connection } as never),
    ])
      expect(create).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: expect.stringMatching(/^Unknown .* option: connection$/),
        }),
      );
  });
});
