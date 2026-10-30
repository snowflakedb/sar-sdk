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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SarError, fail, keys } from "../core/errors.js";
import { HttpTransport } from "../core/http.js";

/** Username and password are resolved together from a single source. */
export interface PasswordSecret {
  username: string;
  password: string;
}
/** Secret source may return undefined only when absent, not when revoked. */
export interface SecretProvider {
  readonly id: string;
  resolve(
    name: string,
    type: "string" | "password" | "accessToken",
  ): Promise<string | PasswordSecret | undefined>;
}
/** No SQL authentication is performed by these methods. */
export interface Secrets {
  getString(name: string): Promise<string>;
  getPassword(name: string): Promise<PasswordSecret>;
  getAccessToken(name: string): Promise<string>;
}
export interface SecretsOptions {
  directory?: string;
  envPrefix?: string;
  providers?: readonly SecretProvider[];
}
export interface SecretsClient extends Secrets {
  close(): Promise<void>;
}

/** Standalone secrets own their HTTP transport and never resolve SQL credentials. */
export function createSecrets(options: SecretsOptions = {}): SecretsClient {
  keys(options, ["directory", "envPrefix", "providers"], "secrets");
  const http = new HttpTransport();
  const secrets = createSecretStore(options, http, () => {});
  return Object.freeze({
    ...secrets,
    close() {
      secrets.close();
      return http.close();
    },
  });
}

async function field(name: string, filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SarError("SECRET_UNAVAILABLE", `Mounted secret '${name}' could not be read`);
  }
}

type TokenConfig = {
  url: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string | undefined;
  accessToken: string | undefined;
};
type TokenGeneration = {
  config: TokenConfig;
  controller: AbortController;
  cached?: { value: string; expires: number };
  inflight?: Promise<string>;
};

export function createSecretStore(
  options: SecretsOptions | undefined,
  http: HttpTransport,
  assertOpen: () => void,
): Secrets & { close(): void } {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)))
    fail("INVALID_OPTIONS", "Secret options must be an object");
  if (
    options?.directory !== undefined &&
    (typeof options.directory !== "string" || !options.directory.trim())
  )
    fail("INVALID_OPTIONS", "Secret directory must be a nonempty string");
  if (options?.envPrefix !== undefined && typeof options.envPrefix !== "string")
    fail("INVALID_OPTIONS", "Secret environment prefix must be a string");
  const directory = path.resolve(options?.directory ?? "/secrets");
  const prefix = options?.envPrefix ?? "SNOWFLAKE_SECRET_";
  const generations = new Map<string, TokenGeneration>();
  const mountedNames = new Set<string>();
  let closed = false;
  const ensureOpen = () => {
    if (closed) fail("CLIENT_CLOSED", "Client is closed");
    assertOpen();
  };
  const variable = (name: string, suffix: string) => `${prefix}${name.toUpperCase()}_${suffix}`;
  const environment = (name: string, suffix: string) => process.env[variable(name, suffix)];
  function invalidate(name: string): void {
    const previous = generations.get(name);
    if (!previous) return;
    generations.delete(name);
    previous.cached = undefined;
    previous.inflight = undefined;
    previous.controller.abort(new SarError("SECRET_UNAVAILABLE", "Secret configuration changed"));
  }
  function ownMount(name: string): void {
    mountedNames.add(name);
    invalidate(name);
  }
  const mounted: SecretProvider = {
    id: "mount",
    async resolve(name, type) {
      const root = path.join(directory, name);
      try {
        await stat(root);
        ensureOpen();
        ownMount(name);
      } catch (error) {
        ensureOpen();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          ownMount(name);
          fail("SECRET_UNAVAILABLE", `Mounted secret '${name}' could not be read`);
        }
      }
      if (type === "password") {
        const [username, password] = await Promise.all([
          field(name, path.join(root, "username")),
          field(name, path.join(root, "password")),
        ]);
        ensureOpen();
        if (username !== undefined || password !== undefined) ownMount(name);
        if (username === undefined && password === undefined && !mountedNames.has(name))
          return undefined;
        if (!username || !password)
          fail(
            "SECRET_UNAVAILABLE",
            `Mounted password secret '${name}' is incomplete, empty, or revoked`,
          );
        return { username, password };
      }
      const value = await field(
        name,
        path.join(root, type === "string" ? "secret_string" : "access_token"),
      );
      ensureOpen();
      if (value !== undefined) ownMount(name);
      if (
        (value === undefined && mountedNames.has(name)) ||
        value === "" ||
        (type === "accessToken" && value !== undefined && !value.trim())
      )
        fail(
          "SECRET_UNAVAILABLE",
          `Mounted secret '${name}' is incomplete, empty, or revoked; environment fallback is disabled`,
        );
      return type === "accessToken" ? value?.trim() : value;
    },
  };
  function currentGeneration(name: string): TokenGeneration {
    const config: TokenConfig = {
      url: environment(name, "OAUTH_TOKEN_URL"),
      clientId: environment(name, "OAUTH_CLIENT_ID"),
      clientSecret: environment(name, "OAUTH_CLIENT_SECRET"),
      scope: environment(name, "OAUTH_SCOPE"),
      accessToken: environment(name, "ACCESS_TOKEN"),
    };
    const previous = generations.get(name);
    if (
      previous &&
      (Object.keys(config) as (keyof TokenConfig)[]).every(
        (key) => config[key] === previous.config[key],
      )
    )
      return previous;
    invalidate(name);
    const generation = { config, controller: new AbortController() };
    generations.set(name, generation);
    return generation;
  }
  function assertCurrent(name: string, generation: TokenGeneration): void {
    ensureOpen();
    if (generations.get(name) !== generation || currentGeneration(name) !== generation)
      fail("SECRET_UNAVAILABLE", `Secret '${name}' configuration changed during token acquisition`);
  }
  function oauthEndpoint(name: string, config: TokenConfig): string | undefined {
    if (config.url === undefined) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      return fail(
        "INVALID_OPTIONS",
        `OAuth token endpoint for secret '${name}' must be a valid HTTPS URL`,
      );
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
      fail(
        "INVALID_OPTIONS",
        `OAuth token endpoint for secret '${name}' must use HTTPS without embedded credentials`,
      );
    if (!config.clientId?.trim() || !config.clientSecret?.trim())
      fail("SECRET_UNAVAILABLE", `OAuth client credentials for secret '${name}' are incomplete`);
    return parsed.href;
  }
  async function oauth(name: string, generation: TokenGeneration, url: string): Promise<string> {
    const { clientId, clientSecret, scope } = generation.config;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId!,
      client_secret: clientSecret!,
    });
    if (scope) body.set("scope", scope);
    const started = Date.now();
    let response: Response;
    try {
      response = await http.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: generation.controller.signal,
      });
    } catch {
      assertCurrent(name, generation);
      return fail("HTTP_FAILED", `OAuth token acquisition failed for secret '${name}'`);
    }
    try {
      assertCurrent(name, generation);
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      fail(
        "HTTP_FAILED",
        `OAuth token endpoint for secret '${name}' returned HTTP ${response.status}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      assertCurrent(name, generation);
      return fail("HTTP_FAILED", `OAuth token response for secret '${name}' could not be read`);
    }
    assertCurrent(name, generation);
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string" ||
      !payload.access_token.trim()
    )
      fail(
        "SECRET_UNAVAILABLE",
        `OAuth response for secret '${name}' did not contain an access token`,
      );
    const expiry = "expires_in" in payload ? payload.expires_in : undefined;
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) {
      const lifetime = expiry * 1000;
      const expires = started + lifetime - Math.min(60_000, lifetime / 10);
      if (Number.isFinite(expires) && expires <= Number.MAX_SAFE_INTEGER) {
        if (expires <= Date.now())
          fail("SECRET_UNAVAILABLE", `OAuth token for secret '${name}' expired during acquisition`);
        generation.cached = { value: payload.access_token, expires };
      }
    }
    return payload.access_token;
  }
  const local: SecretProvider = {
    id: "environment",
    async resolve(name, type) {
      // Another read may have observed a mount while this one was awaiting I/O.
      if (mountedNames.has(name))
        fail(
          "SECRET_UNAVAILABLE",
          `Mounted secret '${name}' is unavailable; environment fallback is disabled`,
        );
      if (type === "string") return environment(name, "SECRET_STRING");
      if (type === "password") {
        const username = environment(name, "USERNAME");
        const password = environment(name, "PASSWORD");
        if (username === undefined && password === undefined) return undefined;
        if (!username || !password)
          fail("SECRET_UNAVAILABLE", `Environment password secret '${name}' is incomplete`);
        return { username, password };
      }
      const generation = currentGeneration(name);
      // Validate the complete current configuration before looking at cached work.
      const url = oauthEndpoint(name, generation.config);
      if (url === undefined) return generation.config.accessToken;
      if (generation.cached && generation.cached.expires > Date.now())
        return generation.cached.value;
      generation.cached = undefined;
      let pending = generation.inflight;
      if (!pending) {
        pending = oauth(name, generation, url).finally(() => {
          if (generation.inflight === pending) generation.inflight = undefined;
        });
        generation.inflight = pending;
      }
      return pending;
    },
  };
  function snapshotProviders(): readonly SecretProvider[] {
    const supplied = options?.providers;
    if (supplied === undefined) return [mounted, local];
    if (!Array.isArray(supplied)) fail("INVALID_OPTIONS", "Secret providers must be an array");
    const ids = new Set<string>();
    return Array.from(supplied, (provider) => {
      let id: unknown;
      let resolver: unknown;
      try {
        if (provider && typeof provider === "object" && !Array.isArray(provider)) {
          id = provider.id;
          resolver = provider.resolve;
        }
      } catch {
        fail("INVALID_OPTIONS", "Secret provider could not be read");
      }
      if (typeof id !== "string" || !id.trim() || typeof resolver !== "function")
        fail("INVALID_OPTIONS", "Secret providers require a nonempty ID and a resolver");
      if (ids.has(id)) fail("INVALID_OPTIONS", "Secret provider IDs must be unique");
      ids.add(id);
      const resolveProvider = resolver.bind(provider) as SecretProvider["resolve"];
      return {
        id,
        async resolve(name, type) {
          try {
            return await resolveProvider(name, type);
          } catch {
            ensureOpen();
            return fail("SECRET_UNAVAILABLE", `Secret provider resolution failed for '${name}'`);
          }
        },
      };
    });
  }
  const providers = snapshotProviders();
  function validateValue(
    name: string,
    value: unknown,
    type: "string" | "password" | "accessToken",
  ): string | PasswordSecret {
    try {
      if (type === "password") {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "username" in value &&
          "password" in value
        ) {
          const { username, password } = value;
          if (typeof username === "string" && username && typeof password === "string" && password)
            return { username, password };
        }
      } else if (typeof value === "string" && (type !== "accessToken" || value.trim()))
        return value;
    } catch {
      // Provider-owned objects may have throwing getters; never expose their errors.
    }
    return fail("SECRET_UNAVAILABLE", `Provider returned an invalid secret value for '${name}'`);
  }
  function localVariables(name: string, type: "string" | "password" | "accessToken"): string {
    if (type === "string") return variable(name, "SECRET_STRING");
    if (type === "password")
      return `${variable(name, "USERNAME")} and ${variable(name, "PASSWORD")}`;
    return (
      `${variable(name, "ACCESS_TOKEN")} (or ${variable(name, "OAUTH_TOKEN_URL")}, ` +
      `${variable(name, "OAUTH_CLIENT_ID")}, and ${variable(name, "OAUTH_CLIENT_SECRET")})`
    );
  }
  async function resolve(
    name: string,
    type: "string" | "password" | "accessToken",
  ): Promise<string | PasswordSecret> {
    ensureOpen();
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))
      fail(
        "INVALID_OPTIONS",
        "Secret name must contain only letters, digits, underscores, or hyphens",
      );
    for (const provider of providers) {
      const value = await provider.resolve(name, type);
      ensureOpen();
      if (value !== undefined) return validateValue(name, value, type);
    }
    throw new SarError(
      "SECRET_NOT_FOUND",
      `Secret '${name}' is not available. Declare its mount or configure a local secret source.`,
      providers.includes(local)
        ? { nextStep: `Declare the secret's mount, or set ${localVariables(name, type)} locally.` }
        : {},
    );
  }
  return Object.freeze({
    getString: (name: string) => resolve(name, "string") as Promise<string>,
    getPassword: (name: string) => resolve(name, "password") as Promise<PasswordSecret>,
    getAccessToken: (name: string) => resolve(name, "accessToken") as Promise<string>,
    // Internal lifecycle hook: the client must call this when shutdown starts.
    close() {
      if (closed) return;
      closed = true;
      for (const name of generations.keys()) invalidate(name);
      mountedNames.clear();
    },
  });
}
