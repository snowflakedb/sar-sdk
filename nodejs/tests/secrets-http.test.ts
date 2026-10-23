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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/auth.js";
import { createSecretStore as createSecrets } from "../src/secrets.js";
import { HttpTransport, relativeAccountUrl } from "../src/http.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-secrets-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("secret isolation", () => {
  it("is async, preserves content, and never requires SQL credentials", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_KEY_SECRET_STRING", " value \n");
    const client = createSarClient({
      secrets: { directory },
      connectionOptions: createConnectionOptions([]),
    });
    const read = client.secrets.getString("KEY");
    expect(read).toBeInstanceOf(Promise);
    expect(await read).toBe(" value \n");
    await client.close();
    await expect(client.secrets.getString("KEY")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
  it("does not fall back after mounted secret revocation", async () => {
    await mkdir(path.join(directory, "KEY"));
    await writeFile(path.join(directory, "KEY/secret_string"), "");
    vi.stubEnv("SNOWFLAKE_SECRET_KEY_SECRET_STRING", "stale-env");
    const client = createSarClient({ secrets: { directory } });
    await expect(client.secrets.getString("KEY")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    await client.close();
  });
  it("does not combine password fields from unrelated sources", async () => {
    await mkdir(path.join(directory, "LOGIN"));
    await writeFile(path.join(directory, "LOGIN/username"), "mounted-user");
    vi.stubEnv("SNOWFLAKE_SECRET_LOGIN_PASSWORD", "env-password");
    const client = createSarClient({ secrets: { directory } });
    await expect(client.secrets.getPassword("LOGIN")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    await expect(client.secrets.getString("../outside")).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await client.close();
  });
  it("coalesces OAuth renewal and caches only explicit expiry", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_TOKEN_URL", "https://provider.example/token");
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_ID", "id");
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_SECRET", "secret");
    const http = new HttpTransport();
    const fetch = vi
      .spyOn(http, "fetch")
      .mockImplementation(async () => Response.json({ access_token: "token", expires_in: 3600 }));
    const secrets = createSecrets({ directory }, http, () => {});
    expect(
      await Promise.all([secrets.getAccessToken("API"), secrets.getAccessToken("API")]),
    ).toEqual(["token", "token"]);
    await secrets.getAccessToken("API");
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("grant_type=client_credentials");
    await http.close();
  });
});

describe("REST boundaries", () => {
  it.each([
    "https://attacker.example/x",
    "//attacker.example/x",
    "/\\attacker.example/x",
    "/x#fragment",
    "/\n/attacker",
  ])("rejects unsafe path %s", (pathname) => {
    expect(() => relativeAccountUrl("https://account.example", pathname)).toThrow();
  });
  it("resolves only same-origin paths", () => {
    expect(relativeAccountUrl("https://account.example", "/api/v2/statements?limit=1")).toBe(
      "https://account.example/api/v2/statements?limit=1",
    );
  });
  it("rejects caller authorization headers before acquiring credentials", async () => {
    const resolve = vi.fn();
    const client = createSarClient({
      connectionOptions: createConnectionOptions([{ id: "test", resolve }]),
    });
    await expect(client.fetch("/api", { headers: { authorization: "bad" } })).rejects.toMatchObject(
      { code: "INVALID_OPTIONS" },
    );
    expect(resolve).not.toHaveBeenCalled();
    await client.close();
  });
});
