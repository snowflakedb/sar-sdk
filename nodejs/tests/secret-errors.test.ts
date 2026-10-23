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

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { SarError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { createSarClient } from "../src/index.js";
import { createSecrets } from "../src/secret-client.js";
import { createSecretStore } from "../src/secrets.js";
import type { SarClientOptions, SecretProvider, Secrets } from "../src/types.js";

// No test in this file can create a dispatcher or use the network.
vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    throw new Error("Unexpected dispatcher creation");
  }),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected transport call");
  }),
}));
// Mount reads use the temporary directory unless a test injects a filesystem failure.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

// Synthetic values that must never reach an error's message, JSON, or inspection.
const values = {
  mounted: "synthetic-mounted-value",
  environment: "synthetic-environment-value",
  credential: "synthetic-client-credential",
  token: "synthetic-token-response",
  failure: "synthetic-underlying-failure",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const notFound = (name: string) =>
  `Secret '${name}' is not available. Declare its mount or configure a local secret source.`;

const filesystemError = (code: string, filename: string) =>
  Object.assign(new Error(`${code}: ${values.failure}, open '${filename}'`), {
    code,
    path: filename,
  });

function configureOAuth() {
  vi.stubEnv("SNOWFLAKE_SECRET_PARTNER_API_OAUTH_TOKEN_URL", "https://provider.invalid/token");
  vi.stubEnv("SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_SECRET", values.credential);
}

function read(secrets: Secrets, type: "string" | "password" | "accessToken", name: string) {
  if (type === "string") return secrets.getString(name);
  return type === "password" ? secrets.getPassword(name) : secrets.getAccessToken(name);
}

let directory: string;
let http: HttpTransport;
let fetch: MockInstance<HttpTransport["fetch"]>;
const stores: { close(): void }[] = [];

function store(options: SarClientOptions["secrets"] = { directory }, assertOpen = () => {}) {
  const secrets = createSecretStore(options, http, assertOpen);
  stores.push(secrets);
  return secrets;
}

/** Returns the rejection after checking that it exposes no value, path, or cause. */
async function rejection(pending: Promise<unknown>): Promise<SarError> {
  const error: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SarError);
  const sarError = error as SarError;
  expect(sarError.cause).toBeUndefined();
  const rendered = [
    sarError.message,
    JSON.stringify(sarError),
    inspect(sarError, { showHidden: true, depth: null }),
  ].join("\n");
  for (const marker of [directory, path.basename(directory), ...Object.values(values)])
    expect(rendered).not.toContain(marker);
  return sarError;
}

beforeEach(async () => {
  // Ignore real secret variables in the developer's environment, under any prefix.
  for (const key of Object.keys(process.env))
    if (/_(SECRET_STRING|USERNAME|PASSWORD|ACCESS_TOKEN|OAUTH_[A-Z_]+)$/.test(key))
      vi.stubEnv(key, undefined);
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-secret-errors-"));
  http = new HttpTransport();
  fetch = vi.spyOn(http, "fetch").mockRejectedValue(new Error("No response configured"));
});
afterEach(async () => {
  for (const secrets of stores.splice(0)) secrets.close();
  await http.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(readFile).mockReset();
  vi.mocked(stat).mockReset();
  await rm(directory, { recursive: true, force: true });
});

describe("mounted and environment secret errors", () => {
  it("names unreadable mounts without exposing filesystem errors", async () => {
    vi.mocked(stat).mockRejectedValueOnce(
      filesystemError("EACCES", path.join(directory, "DB_LOGIN")),
    );
    expect(await rejection(store().getPassword("DB_LOGIN"))).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Mounted secret 'DB_LOGIN' could not be read",
    });
    await mkdir(path.join(directory, "API_KEY"));
    vi.mocked(readFile).mockRejectedValueOnce(
      filesystemError("EACCES", path.join(directory, "API_KEY", "secret_string")),
    );
    expect(await rejection(store().getString("API_KEY"))).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Mounted secret 'API_KEY' could not be read",
    });
  });

  it.each([
    {
      type: "password",
      name: "DB_LOGIN",
      files: { username: values.mounted },
      message: "Mounted password secret 'DB_LOGIN' is incomplete, empty, or revoked",
    },
    {
      type: "string",
      name: "API_KEY",
      files: { secret_string: "" },
      message:
        "Mounted secret 'API_KEY' is incomplete, empty, or revoked; environment fallback is disabled",
    },
    {
      type: "accessToken",
      name: "PARTNER_API",
      files: { access_token: " \n" },
      message:
        "Mounted secret 'PARTNER_API' is incomplete, empty, or revoked; environment fallback is disabled",
    },
  ] as const)(
    "names an incomplete mounted $type secret",
    async ({ type, name, files, message }) => {
      await mkdir(path.join(directory, name));
      for (const [file, contents] of Object.entries(files))
        await writeFile(path.join(directory, name, file), contents);
      for (const suffix of ["SECRET_STRING", "USERNAME", "PASSWORD", "ACCESS_TOKEN"])
        vi.stubEnv(`SNOWFLAKE_SECRET_${name}_${suffix}`, values.environment);
      expect(await rejection(read(store(), type, name))).toMatchObject({
        code: "SECRET_UNAVAILABLE",
        message,
      });
    },
  );

  it("names the environment guard when another read observes the mount first", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_API_KEY_SECRET_STRING", values.environment);
    const stats = await stat(directory);
    const observed = deferred<typeof stats>();
    const readStarted = deferred<void>();
    const missingRead = deferred<string>();
    let observeMount: (() => void) | undefined;
    const secrets = store({ directory }, () => observeMount?.());
    vi.mocked(stat).mockImplementationOnce(() => observed.promise);
    vi.mocked(readFile).mockImplementationOnce(() => {
      readStarted.resolve();
      return missingRead.promise;
    });
    const observer = secrets.getString("API_KEY");
    const reader = secrets.getString("API_KEY");
    await readStarted.promise;
    // The next open check follows the reader's file read, so the observer claims the mount
    // after the reader's mount check and before its environment fallback.
    observeMount = () => {
      observeMount = undefined;
      observed.resolve(stats);
    };
    missingRead.reject(filesystemError("ENOENT", path.join(directory, "API_KEY", "secret_string")));
    expect(await rejection(reader)).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Mounted secret 'API_KEY' is unavailable; environment fallback is disabled",
    });
    expect(await rejection(observer)).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message:
        "Mounted secret 'API_KEY' is incomplete, empty, or revoked; environment fallback is disabled",
    });
  });

  it("names an incomplete environment password", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_DB_LOGIN_USERNAME", values.environment);
    expect(await rejection(store().getPassword("DB_LOGIN"))).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Environment password secret 'DB_LOGIN' is incomplete",
    });
  });
});

describe("OAuth secret errors", () => {
  beforeEach(configureOAuth);

  it.each([
    {
      variable: "OAUTH_TOKEN_URL",
      value: `${values.credential}-endpoint`,
      code: "INVALID_OPTIONS",
      message: "OAuth token endpoint for secret 'PARTNER_API' must be a valid HTTPS URL",
    },
    {
      variable: "OAUTH_TOKEN_URL",
      value: `https://client:${values.credential}@provider.invalid/token`,
      code: "INVALID_OPTIONS",
      message:
        "OAuth token endpoint for secret 'PARTNER_API' must use HTTPS without embedded credentials",
    },
    {
      variable: "OAUTH_CLIENT_ID",
      value: "",
      code: "SECRET_UNAVAILABLE",
      message: "OAuth client credentials for secret 'PARTNER_API' are incomplete",
    },
  ])("names the secret: $message", async ({ variable, value, code, message }) => {
    vi.stubEnv(`SNOWFLAKE_SECRET_PARTNER_API_${variable}`, value);
    expect(await rejection(store().getAccessToken("PARTNER_API"))).toMatchObject({
      code,
      message,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      respond: async (): Promise<Response> => {
        throw new Error(values.failure);
      },
      code: "HTTP_FAILED",
      message: "OAuth token acquisition failed for secret 'PARTNER_API'",
    },
    {
      respond: async () => new Response(values.token, { status: 401 }),
      code: "HTTP_FAILED",
      message: "OAuth token endpoint for secret 'PARTNER_API' returned HTTP 401",
    },
    {
      respond: async () => new Response(values.token),
      code: "HTTP_FAILED",
      message: "OAuth token response for secret 'PARTNER_API' could not be read",
    },
    {
      respond: async () => Response.json({ token_type: values.token }),
      code: "SECRET_UNAVAILABLE",
      message: "OAuth response for secret 'PARTNER_API' did not contain an access token",
    },
  ])("names the secret: $message", async ({ respond, code, message }) => {
    fetch.mockImplementationOnce(respond);
    expect(await rejection(store().getAccessToken("PARTNER_API"))).toMatchObject({
      code,
      message,
    });
  });

  it("names a token that expires during acquisition", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetch.mockImplementationOnce(async () => {
      now += 10_000;
      return Response.json({ access_token: values.token, expires_in: 10 });
    });
    expect(await rejection(store().getAccessToken("PARTNER_API"))).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "OAuth token for secret 'PARTNER_API' expired during acquisition",
    });
  });

  it("names the secret when its configuration rotates during acquisition", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const pending = store().getAccessToken("PARTNER_API");
    await started.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_SECRET", "synthetic-rotation");
    response.resolve(Response.json({ access_token: values.token, expires_in: 3600 }));
    expect(await rejection(pending)).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Secret 'PARTNER_API' configuration changed during token acquisition",
    });
  });
});

describe("provider secret errors", () => {
  it("names provider failures without exposing them", async () => {
    const fallback = vi.fn(async () => values.mounted);
    const secrets = store({
      providers: [
        {
          id: "first",
          async resolve() {
            throw new Error(values.failure);
          },
        },
        { id: "second", resolve: fallback },
      ],
    });
    expect(await rejection(secrets.getString("API_KEY"))).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "Secret provider resolution failed for 'API_KEY'",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("names invalid provider values without exposing them", async () => {
    const throwing = {
      get username(): string {
        throw new Error(values.failure);
      },
      password: values.mounted,
    };
    for (const value of [{ username: values.mounted }, throwing]) {
      const provider = { id: "custom", resolve: async () => value } as unknown as SecretProvider;
      expect(
        await rejection(store({ providers: [provider] }).getPassword("DB_LOGIN")),
      ).toMatchObject({
        code: "SECRET_UNAVAILABLE",
        message: "Provider returned an invalid secret value for 'DB_LOGIN'",
      });
    }
  });

  it("omits the local next step when supplied providers replace the built-in sources", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_API_KEY_SECRET_STRING", values.environment);
    const secrets = store({
      directory,
      providers: [{ id: "custom", resolve: async () => undefined }],
    });
    const error = await rejection(secrets.getString("API_KEY"));
    expect(error).toMatchObject({ code: "SECRET_NOT_FOUND", message: notFound("API_KEY") });
    expect(error.details).toEqual({});
  });
});

describe("SECRET_NOT_FOUND next step", () => {
  it.each([
    { envPrefix: undefined, name: "API_KEY", variable: "SNOWFLAKE_SECRET_API_KEY_SECRET_STRING" },
    { envPrefix: "APP_SECRET_", name: "API_KEY", variable: "APP_SECRET_API_KEY_SECRET_STRING" },
    { envPrefix: "", name: "api-key", variable: "API-KEY_SECRET_STRING" },
  ])("names $variable for a string secret", async ({ envPrefix, name, variable }) => {
    const secrets = store({ directory, envPrefix });
    const error = await rejection(secrets.getString(name));
    expect(error).toMatchObject({ code: "SECRET_NOT_FOUND", message: notFound(name) });
    expect(error.details).toEqual({
      nextStep: `Declare the secret's mount, or set ${variable} locally.`,
    });
    vi.stubEnv(variable, values.environment);
    await expect(secrets.getString(name)).resolves.toBe(values.environment);
  });

  it.each([
    {
      envPrefix: undefined,
      username: "SNOWFLAKE_SECRET_DB_LOGIN_USERNAME",
      password: "SNOWFLAKE_SECRET_DB_LOGIN_PASSWORD",
    },
    {
      envPrefix: "APP_SECRET_",
      username: "APP_SECRET_DB_LOGIN_USERNAME",
      password: "APP_SECRET_DB_LOGIN_PASSWORD",
    },
  ])(
    "names $username and $password for a password secret",
    async ({ envPrefix, username, password }) => {
      const secrets = store({ directory, envPrefix });
      const error = await rejection(secrets.getPassword("db_login"));
      expect(error).toMatchObject({ code: "SECRET_NOT_FOUND", message: notFound("db_login") });
      expect(error.details).toEqual({
        nextStep: `Declare the secret's mount, or set ${username} and ${password} locally.`,
      });
      vi.stubEnv(username, "synthetic-user");
      vi.stubEnv(password, values.environment);
      await expect(secrets.getPassword("db_login")).resolves.toEqual({
        username: "synthetic-user",
        password: values.environment,
      });
    },
  );

  it.each([
    {
      envPrefix: undefined,
      direct: "SNOWFLAKE_SECRET_PARTNER_API_ACCESS_TOKEN",
      url: "SNOWFLAKE_SECRET_PARTNER_API_OAUTH_TOKEN_URL",
      clientId: "SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_ID",
      clientSecret: "SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_SECRET",
    },
    {
      envPrefix: "APP_SECRET_",
      direct: "APP_SECRET_PARTNER_API_ACCESS_TOKEN",
      url: "APP_SECRET_PARTNER_API_OAUTH_TOKEN_URL",
      clientId: "APP_SECRET_PARTNER_API_OAUTH_CLIENT_ID",
      clientSecret: "APP_SECRET_PARTNER_API_OAUTH_CLIENT_SECRET",
    },
  ])(
    "names $direct and the OAuth variables for an access token",
    async ({ envPrefix, direct, url, clientId, clientSecret }) => {
      const secrets = store({ directory, envPrefix });
      const error = await rejection(secrets.getAccessToken("PARTNER_API"));
      expect(error).toMatchObject({ code: "SECRET_NOT_FOUND", message: notFound("PARTNER_API") });
      expect(error.details).toEqual({
        nextStep:
          `Declare the secret's mount, or set ${direct} ` +
          `(or ${url}, ${clientId}, and ${clientSecret}) locally.`,
      });
      vi.stubEnv(direct, values.environment);
      await expect(secrets.getAccessToken("PARTNER_API")).resolves.toBe(values.environment);
      vi.stubEnv(direct, undefined);
      vi.stubEnv(url, "https://provider.invalid/token");
      vi.stubEnv(clientId, "synthetic-client");
      vi.stubEnv(clientSecret, values.credential);
      fetch.mockResolvedValueOnce(Response.json({ access_token: values.token }));
      await expect(secrets.getAccessToken("PARTNER_API")).resolves.toBe(values.token);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("uses the configured prefix through the public entry points", async () => {
    const standalone = createSecrets({ directory, envPrefix: "APP_SECRET_" });
    const client = createSarClient({ secrets: { directory, envPrefix: "APP_SECRET_" } });
    try {
      for (const secrets of [standalone, client.secrets])
        expect(await rejection(secrets.getString("API_KEY"))).toMatchObject({
          code: "SECRET_NOT_FOUND",
          message: notFound("API_KEY"),
          details: {
            nextStep:
              "Declare the secret's mount, or set APP_SECRET_API_KEY_SECRET_STRING locally.",
          },
        });
    } finally {
      await Promise.all([standalone.close(), client.close()]);
    }
  });
});

describe("errors without a secret name", () => {
  it.each(["../outside", "API KEY", `${values.mounted}!`, 123, null])(
    "does not echo the invalid name %j",
    async (name) => {
      expect(await rejection(store().getString(name as string))).toMatchObject({
        code: "INVALID_OPTIONS",
        message: "Secret name must contain only letters, digits, underscores, or hyphens",
      });
    },
  );

  it("keeps closed-client errors unnamed", async () => {
    configureOAuth();
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const secrets = store();
    const pending = secrets.getAccessToken("PARTNER_API");
    await started.promise;
    secrets.close();
    response.resolve(Response.json({ access_token: values.token, expires_in: 3600 }));
    for (const closed of [pending, secrets.getString("API_KEY")])
      expect(await rejection(closed)).toMatchObject({
        code: "CLIENT_CLOSED",
        message: "Client is closed",
      });
  });

  it.each(["closed", "reconfigured"] as const)(
    "keeps the abort reason unnamed when the store is %s",
    async (change) => {
      configureOAuth();
      const started = deferred<void>();
      const response = deferred<Response>();
      fetch.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const secrets = store();
      const pending = secrets.getAccessToken("PARTNER_API");
      await started.promise;
      if (change === "closed") secrets.close();
      else vi.stubEnv("SNOWFLAKE_SECRET_PARTNER_API_OAUTH_CLIENT_SECRET", "synthetic-rotation");
      response.resolve(Response.json({ access_token: values.token, expires_in: 3600 }));
      await rejection(pending);
      expect(fetch.mock.calls[0]?.[1]?.signal?.reason).toMatchObject({
        code: "SECRET_UNAVAILABLE",
        message: "Secret configuration changed",
      });
    },
  );
});
