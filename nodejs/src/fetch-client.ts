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
  createConnectionOptions,
  snapshotProvider,
  optionsScope,
  type ConnectionOptionsProvider,
} from "./auth-client.js";
import { endpoint } from "./config.js";
import { duration, fail, isSarError, keys, SarError, signalOption } from "./errors.js";
import { HttpTransport, relativeAccountUrl } from "./http.js";
import { checkAbort, deadline } from "./lifecycle.js";
import { clientOptions } from "./options.js";
import type {
  CallerContext,
  FetchClient,
  FetchClientOptions,
  FetchInit,
  FetchScope,
} from "./types.js";

export function createFetchClient(
  provider?: ConnectionOptionsProvider,
  input: FetchClientOptions = {},
): FetchClient {
  keys(input, ["timeouts"], "fetch client");
  const options = clientOptions(input);
  const owned = provider === undefined ? createConnectionOptions() : undefined;
  const auth = snapshotProvider(provider ?? owned!);
  const http = new HttpTransport(options.timeouts?.httpMs);
  const shutdown = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) fail("CLIENT_CLOSED", "Fetch client is closed");
  };
  function scope(credentials: ReturnType<typeof optionsScope>): FetchScope {
    return Object.freeze({
      async fetch(pathname: string, init: FetchInit = {}): Promise<Response> {
        assertOpen();
        try {
          relativeAccountUrl("https://path-validation.invalid", pathname);
          const headers = new Headers(init.headers);
          for (const name of [
            "authorization",
            "x-snowflake-authorization-token-type",
            "host",
            "cookie",
            "sf-context-current-user-token",
          ])
            if (headers.has(name))
              fail("INVALID_OPTIONS", `REST header '${name}' is managed by the SDK`);
          if (init.redirect && init.redirect !== "error")
            fail("INVALID_OPTIONS", "Authenticated REST redirects are not permitted");
          signalOption(init.signal ?? undefined);
          duration(init.timeoutMs, "timeoutMs");
          if (init.timeoutMs !== undefined && !Number.isInteger(init.timeoutMs))
            fail("INVALID_OPTIONS", "timeoutMs must be an integer");
          checkAbort(init.signal ?? undefined);
          const signal = AbortSignal.any([shutdown.signal, ...(init.signal ? [init.signal] : [])]);
          const resolved = await deadline(
            credentials.acquire({ signal, timeoutMs: options.timeouts?.authMs ?? 120_000 }),
            options.timeouts?.authMs ?? 120_000,
            signal,
            "REST credentials",
          );
          assertOpen();
          const authenticator = resolved.authenticator?.toUpperCase();
          if (
            !["OAUTH", "PROGRAMMATIC_ACCESS_TOKEN"].includes(authenticator ?? "") ||
            typeof resolved.token !== "string" ||
            !resolved.token.trim() ||
            resolved.password !== undefined ||
            resolved.privateKey !== undefined ||
            resolved.privateKeyPath !== undefined ||
            resolved.tokenFilePath !== undefined
          )
            fail(
              "AUTH_NOT_SUPPORTED_FOR_REST",
              "REST currently requires OAuth or PAT source credentials",
            );
          const url = relativeAccountUrl(endpoint(resolved), pathname);
          headers.set("authorization", `Bearer ${resolved.token}`);
          headers.set("x-snowflake-authorization-token-type", authenticator!);
          return await http.fetch(url, { ...init, headers, signal });
        } catch (error) {
          if (isSarError(error)) throw error;
          throw new SarError("HTTP_FAILED", "Account HTTP request failed", {}, error);
        }
      },
    });
  }
  return Object.freeze({
    ...scope(optionsScope(auth)),
    asCaller(context: CallerContext) {
      assertOpen();
      return scope(optionsScope(auth, context));
    },
    close() {
      if (closing) return closing;
      closed = true;
      shutdown.abort();
      closing = Promise.all([http.close(), owned?.close()]).then(() => {});
      return closing;
    },
  });
}
