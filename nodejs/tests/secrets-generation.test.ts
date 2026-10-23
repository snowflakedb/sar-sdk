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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { SarError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { createSecretStore as createSecrets } from "../src/secrets.js";
import type { SarClient, SarClientOptions, SecretProvider } from "../src/types.js";

// No test in this file can create a dispatcher or use the network.
vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    throw new Error("Unexpected dispatcher creation");
  }),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected transport call");
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function configureOAuth() {
  vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_TOKEN_URL", "https://provider.invalid/token");
  vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_ID", "test-client");
  vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_SECRET", "test-credential");
  vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_SCOPE", undefined);
  vi.stubEnv("SNOWFLAKE_SECRET_API_ACCESS_TOKEN", undefined);
}

let directory: string;
let http: HttpTransport;
let fetch: MockInstance<HttpTransport["fetch"]>;
let secrets: ReturnType<typeof createSecrets>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sar-secret-generations-"));
  http = new HttpTransport();
  fetch = vi.spyOn(http, "fetch").mockRejectedValue(new Error("No response configured"));
  secrets = createSecrets({ directory }, http, () => {});
});
afterEach(async () => {
  secrets.close();
  await http.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("mounted ownership", () => {
  it.each(["string", "password", "accessToken"] as const)(
    "retains %s ownership after the whole mount is removed",
    async (type) => {
      const root = path.join(directory, "ITEM");
      await mkdir(root);
      await writeFile(path.join(root, "secret_string"), "mounted-string");
      await writeFile(path.join(root, "username"), "mounted-user");
      await writeFile(path.join(root, "password"), "mounted-password");
      await writeFile(path.join(root, "access_token"), " mounted-token\n");
      vi.stubEnv("SNOWFLAKE_SECRET_ITEM_SECRET_STRING", "environment-string");
      vi.stubEnv("SNOWFLAKE_SECRET_ITEM_USERNAME", "environment-user");
      vi.stubEnv("SNOWFLAKE_SECRET_ITEM_PASSWORD", "environment-password");
      vi.stubEnv("SNOWFLAKE_SECRET_ITEM_ACCESS_TOKEN", "environment-token");
      const read = () =>
        type === "string"
          ? secrets.getString("ITEM")
          : type === "password"
            ? secrets.getPassword("ITEM")
            : secrets.getAccessToken("ITEM");
      expect(await read()).toEqual(
        type === "string"
          ? "mounted-string"
          : type === "password"
            ? { username: "mounted-user", password: "mounted-password" }
            : "mounted-token",
      );
      await rm(root, { recursive: true });
      await expect(read()).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
      await expect(secrets.getString("ITEM")).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("claims empty mounts and permits a restored mount, never the environment", async () => {
    const root = path.join(directory, "ITEM");
    vi.stubEnv("SNOWFLAKE_SECRET_ITEM_SECRET_STRING", "environment");
    await mkdir(root);
    await expect(secrets.getString("ITEM")).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await rm(root, { recursive: true });
    await expect(secrets.getString("ITEM")).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await mkdir(root);
    await writeFile(path.join(root, "secret_string"), "restored");
    await expect(secrets.getString("ITEM")).resolves.toBe("restored");
  });

  it("invalidates pending environment OAuth when a mount is observed", async () => {
    configureOAuth();
    const started = deferred<void>();
    const pendingResponse = deferred<Response>();
    fetch.mockImplementation(() => {
      started.resolve();
      return pendingResponse.promise;
    });
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await started.promise;
    await mkdir(path.join(directory, "API"));
    await writeFile(path.join(directory, "API/access_token"), "mounted-token");
    await expect(secrets.getAccessToken("API")).resolves.toBe("mounted-token");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pendingResponse.resolve(Response.json({ access_token: "old-token", expires_in: 3600 }));
    await rejected;
    await rm(path.join(directory, "API"), { recursive: true });
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
  });
});

describe("OAuth generations", () => {
  beforeEach(configureOAuth);

  it.each([
    ["OAUTH_TOKEN_URL", "https://provider.invalid/rotated"],
    ["OAUTH_CLIENT_ID", "rotated-client"],
    ["OAUTH_CLIENT_SECRET", "rotated-credential"],
    ["OAUTH_SCOPE", "read:synthetic"],
    ["ACCESS_TOKEN", "rotated-static-token"],
  ])("does not reuse a cached token after %s changes", async (suffix, value) => {
    fetch
      .mockResolvedValueOnce(Response.json({ access_token: "first", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ access_token: "second", expires_in: 3600 }));
    await expect(secrets.getAccessToken("API")).resolves.toBe("first");
    vi.stubEnv(`SNOWFLAKE_SECRET_API_${suffix}`, value);
    await expect(secrets.getAccessToken("API")).resolves.toBe("second");
    await expect(secrets.getAccessToken("API")).resolves.toBe("second");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.body).toBeInstanceOf(URLSearchParams);
  });

  it.each(["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET"])(
    "validates revoked %s before reuse and discards the old cache",
    async (suffix) => {
      fetch.mockImplementation(async () =>
        Response.json({ access_token: "token", expires_in: 3600 }),
      );
      await secrets.getAccessToken("API");
      const original = process.env[`SNOWFLAKE_SECRET_API_${suffix}`];
      vi.stubEnv(`SNOWFLAKE_SECRET_API_${suffix}`, undefined);
      await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
        code: "SECRET_UNAVAILABLE",
      });
      expect(fetch).toHaveBeenCalledOnce();
      vi.stubEnv(`SNOWFLAKE_SECRET_API_${suffix}`, original);
      await secrets.getAccessToken("API");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects invalid URLs before cache reuse without exposing input", async () => {
    fetch.mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }));
    await secrets.getAccessToken("API");
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_TOKEN_URL", "synthetic-invalid-url");
    const error = await secrets.getAccessToken("API").catch((error) => error);
    expect(error).toMatchObject({ code: "INVALID_OPTIONS" });
    expect(inspect(error)).not.toContain("synthetic-invalid-url");
    expect(error.cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("invalidates the OAuth cache when switching to a direct token and back", async () => {
    fetch.mockImplementation(async () =>
      Response.json({ access_token: "oauth", expires_in: 3600 }),
    );
    await secrets.getAccessToken("API");
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_TOKEN_URL", undefined);
    vi.stubEnv("SNOWFLAKE_SECRET_API_ACCESS_TOKEN", "direct");
    await expect(secrets.getAccessToken("API")).resolves.toBe("direct");
    configureOAuth();
    await expect(secrets.getAccessToken("API")).resolves.toBe("oauth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects old in-flight results without removing the replacement request", async () => {
    const oldStarted = deferred<void>();
    const newStarted = deferred<void>();
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    fetch
      .mockImplementationOnce(() => {
        oldStarted.resolve();
        return oldResponse.promise;
      })
      .mockImplementationOnce(() => {
        newStarted.resolve();
        return newResponse.promise;
      });
    const old = secrets.getAccessToken("API");
    const oldRejected = expect(old).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await oldStarted.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_SECRET", "rotated-credential");
    const current = secrets.getAccessToken("API");
    await newStarted.promise;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("client_secret=test-credential");
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain("client_secret=rotated-credential");
    oldResponse.resolve(Response.json({ access_token: "obsolete", expires_in: 3600 }));
    await oldRejected;
    const coalesced = secrets.getAccessToken("API");
    newResponse.resolve(Response.json({ access_token: "current", expires_in: 3600 }));
    await expect(Promise.all([current, coalesced])).resolves.toEqual(["current", "current"]);
    await expect(secrets.getAccessToken("API")).resolves.toBe("current");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("detects configuration changes on response completion without a second lookup", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await started.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_SECRET", undefined);
    response.resolve(Response.json({ access_token: "obsolete", expires_in: 3600 }));
    await rejected;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("validates revoked credentials before joining in-flight work", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await started.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_ID", "");
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    response.resolve(Response.json({ access_token: "obsolete", expires_in: 3600 }));
    await rejected;
  });

  it("checks for rotation again after response JSON is read", async () => {
    const started = deferred<void>();
    const payload = deferred<unknown>();
    const response = new Response();
    vi.spyOn(response, "json").mockImplementation(() => {
      started.resolve();
      return payload.promise;
    });
    fetch.mockResolvedValueOnce(response);
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await started.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_SCOPE", "rotated-scope");
    payload.resolve({ access_token: "obsolete", expires_in: 3600 });
    await rejected;
    fetch.mockResolvedValueOnce(Response.json({ access_token: "fresh", expires_in: 3600 }));
    await expect(secrets.getAccessToken("API")).resolves.toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not use a direct token when an explicitly configured OAuth URL is empty", async () => {
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_TOKEN_URL", "");
    vi.stubEnv("SNOWFLAKE_SECRET_API_ACCESS_TOKEN", "direct");
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept an old generation when configuration changes away and back", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch
      .mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      })
      .mockImplementation(async () => Response.json({ access_token: "fresh", expires_in: 3600 }));
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    await started.promise;
    vi.stubEnv("SNOWFLAKE_SECRET_API_OAUTH_CLIENT_SECRET", "rotation");
    await secrets.getAccessToken("API");
    configureOAuth();
    await secrets.getAccessToken("API");
    response.resolve(Response.json({ access_token: "old", expires_in: 3600 }));
    await rejected;
    await expect(secrets.getAccessToken("API")).resolves.toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a failed renewal instead of retaining a rejected promise", async () => {
    fetch
      .mockRejectedValueOnce(new Error("synthetic transport failure"))
      .mockResolvedValueOnce(Response.json({ access_token: "retried", expires_in: 3600 }));
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({ code: "HTTP_FAILED" });
    await expect(secrets.getAccessToken("API")).resolves.toBe("retried");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    "3600",
    true,
    Number.MAX_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("does not cache expiry %s", async (expires) => {
    fetch.mockImplementation(async () => {
      const response = new Response();
      vi.spyOn(response, "json").mockResolvedValue({
        access_token: "uncached",
        expires_in: expires,
      });
      return response;
    });
    await expect(secrets.getAccessToken("API")).resolves.toBe("uncached");
    await expect(secrets.getAccessToken("API")).resolves.toBe("uncached");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("calculates expiry from request start including response parsing time", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetch.mockImplementation(async () => {
      now += 4_000;
      const response = new Response();
      vi.spyOn(response, "json").mockImplementation(async () => {
        now += 4_000;
        return { access_token: "token", expires_in: 10 };
      });
      return response;
    });
    await secrets.getAccessToken("API");
    await secrets.getAccessToken("API");
    expect(fetch).toHaveBeenCalledOnce();
    now = 1_009_001;
    await secrets.getAccessToken("API");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a token whose conservative expiry passed during acquisition", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetch.mockImplementation(async () => {
      now += 10_000;
      return Response.json({ access_token: "expired", expires_in: 10 });
    });
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, [], {}, { access_token: " " }, { access_token: 123 }])(
    "rejects an invalid token response: %j",
    async (payload) => {
      fetch.mockImplementation(async () => Response.json(payload));
      await expect(secrets.getAccessToken("API")).rejects.toMatchObject({
        code: "SECRET_UNAVAILABLE",
      });
    },
  );

  it("sanitizes token transport and JSON errors, including nested causes", async () => {
    const marker = "synthetic-sensitive-error-marker";
    fetch.mockRejectedValueOnce(new SarError("HTTP_FAILED", marker));
    const error = await secrets.getAccessToken("API").catch((error) => error);
    expect(error).toMatchObject({ code: "HTTP_FAILED" });
    expect(`${inspect(error)} ${JSON.stringify(error)}`).not.toContain(marker);
    expect(error.cause).toBeUndefined();
    fetch.mockResolvedValueOnce(new Response("synthetic-invalid-json"));
    const parseError = await secrets.getAccessToken("API").catch((error) => error);
    expect(parseError).toMatchObject({ code: "HTTP_FAILED" });
    expect(inspect(parseError)).not.toContain("synthetic-invalid-json");
    expect(parseError.cause).toBeUndefined();
  });

  it("cancels failed HTTP bodies without exposing their contents", async () => {
    const response = new Response("synthetic-sensitive-body", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel");
    fetch.mockResolvedValueOnce(response);
    const error = await secrets.getAccessToken("API").catch((error) => error);
    expect(error).toMatchObject({ code: "HTTP_FAILED" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(inspect(error)).not.toContain("synthetic-sensitive-body");
  });
});

describe("provider snapshots and validation", () => {
  it("snapshots the provider list and method while preserving method binding", async () => {
    const provider = {
      id: "original",
      value: "synthetic-value",
      async resolve() {
        return this.value;
      },
    };
    const providers = [provider];
    const custom = createSecrets({ providers }, http, () => {});
    provider.resolve = async () => "replacement";
    providers.splice(0, 1, {
      id: "replacement",
      value: "replacement",
      async resolve() {
        return this.value;
      },
    });
    await expect(custom.getString("KEY")).resolves.toBe("synthetic-value");
    custom.close();
  });

  it.each([
    null,
    {},
    [null],
    [{}],
    [{ id: "", resolve() {} }],
    [{ id: "source", resolve: 1 }],
    new Array(1),
    [
      { id: "same", resolve() {} },
      { id: "same", resolve() {} },
    ],
  ])("rejects invalid providers: %j", (providers) => {
    expect(() =>
      createSecrets({ providers } as unknown as SarClientOptions["secrets"], http, () => {}),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
  });

  it.each([null, { directory: 1 }, { directory: "" }, { envPrefix: 1 }])(
    "validates runtime options: %j",
    (options) => {
      expect(() => createSecrets(options as SarClientOptions["secrets"], http, () => {})).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS" }),
      );
    },
  );

  it.each([null, undefined, 123, {}])("rejects non-string names: %j", async (name) => {
    await expect(secrets.getString(name as string)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  it.each([
    null,
    [],
    {},
    { username: "u" },
    { username: "u", password: "" },
    { username: "", password: "p" },
  ])("rejects invalid password output: %j", async (value) => {
    const custom = createSecrets(
      { providers: [{ id: "test", resolve: async () => value } as SecretProvider] },
      http,
      () => {},
    );
    await expect(custom.getPassword("KEY")).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
    custom.close();
  });

  it("copies password values rather than returning provider-owned objects", async () => {
    const value = { username: "user", password: "password", internal: "private" };
    const custom = createSecrets(
      { providers: [{ id: "test", resolve: async () => value }] },
      http,
      () => {},
    );
    const result = await custom.getPassword("KEY");
    value.password = "rotated";
    expect(result).toEqual({ username: "user", password: "password" });
    custom.close();
  });

  it("sanitizes provider failures and does not fall through to another provider", async () => {
    const fallback = vi.fn(async () => "fallback");
    const custom = createSecrets(
      {
        providers: [
          {
            id: "first",
            async resolve() {
              throw new SarError("SECRET_UNAVAILABLE", "synthetic-sensitive-marker");
            },
          },
          { id: "second", resolve: fallback },
        ],
      },
      http,
      () => {},
    );
    const error = await custom.getString("KEY").catch((error) => error);
    expect(error).toMatchObject({ code: "SECRET_UNAVAILABLE" });
    expect(inspect(error)).not.toContain("synthetic-sensitive-marker");
    expect(error.cause).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
    custom.close();
  });

  it("allows fallback only for undefined and preserves empty generic strings", async () => {
    const custom = createSecrets(
      {
        providers: [
          { id: "absent", resolve: async () => undefined },
          { id: "present", resolve: async () => "" },
        ],
      },
      http,
      () => {},
    );
    await expect(custom.getString("KEY")).resolves.toBe("");
    await expect(custom.getAccessToken("KEY")).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    custom.close();
  });
});

describe("secret shutdown", () => {
  it("is idempotent and rejects pending and subsequent token lookups", async () => {
    configureOAuth();
    const started = deferred<void>();
    const response = deferred<Response>();
    fetch.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await started.promise;
    secrets.close();
    secrets.close();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    response.resolve(Response.json({ access_token: "late", expires_in: 3600 }));
    await rejected;
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(secrets.getString("KEY")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects cached reads after closing", async () => {
    configureOAuth();
    fetch.mockResolvedValueOnce(Response.json({ access_token: "cached", expires_in: 3600 }));
    await secrets.getAccessToken("API");
    secrets.close();
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks parent client shutdown after asynchronous provider resolution", async () => {
    const pendingValue = deferred<string>();
    let closed = false;
    const custom = createSecrets(
      { providers: [{ id: "test", resolve: () => pendingValue.promise }] },
      http,
      () => {
        if (closed) throw new SarError("CLIENT_CLOSED", "Client is closed");
      },
    );
    const pending = custom.getString("KEY");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    closed = true;
    pendingValue.resolve("late");
    await rejected;
    custom.close();
  });

  it("discards OAuth completion after parent shutdown even before internal disposal", async () => {
    configureOAuth();
    const started = deferred<void>();
    const response = deferred<Response>();
    let closed = false;
    secrets = createSecrets({ directory }, http, () => {
      if (closed) throw new SarError("CLIENT_CLOSED", "Client is closed");
    });
    fetch.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const pending = secrets.getAccessToken("API");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await started.promise;
    closed = true;
    response.resolve(Response.json({ access_token: "late", expires_in: 3600 }));
    await rejected;
    await expect(secrets.getAccessToken("API")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the internal lifecycle hook out of the public client type", () => {
    expectTypeOf<SarClient["secrets"]>().not.toHaveProperty("close");
    expectTypeOf<ReturnType<typeof createSecrets>>().toHaveProperty("close");
  });
});
