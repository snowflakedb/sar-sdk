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
  snapshotProvider,
  unconfiguredOptions,
  optionsScope,
} from "../connection-options/connection-options.js";
import type { ConnectionOptionsProvider } from "../connection-options/connection-options.js";
import type { CallerContext } from "../connection-options/caller.js";
import { endpoint } from "../connection-options/config.js";
import { duration, fail, isSarError, keys, SarError, signalOption } from "../core/errors.js";
import { HttpTransport, relativeAccountUrl, type FetchInit } from "../core/http.js";
import { checkAbort } from "../core/lifecycle.js";
import { timeoutOptions, type TimeoutOptions } from "../core/timeouts.js";

export type { FetchInit } from "../core/http.js";
export type FetchClientOptions = { timeouts?: TimeoutOptions };
export interface FetchScope {
  /**
   * Authenticated fetch to an account-relative path, retaining this view's identity.
   * Redirects are rejected; consume or cancel the returned response body.
   * Throws AUTH_NOT_SUPPORTED_FOR_REST when the credential cannot authorize HTTP.
   */
  fetch(path: string, init?: FetchInit): Promise<Response>;
}
export interface FetchClient extends FetchScope {
  asCaller(context: CallerContext): FetchScope;
  close(): Promise<void>;
}

export function createFetchClient(
  provider?: ConnectionOptionsProvider,
  input: FetchClientOptions = {},
): FetchClient {
  keys(input, ["timeouts"], "fetch client");
  const options = { timeouts: timeoutOptions(input.timeouts) };
  const auth = snapshotProvider(provider ?? unconfiguredOptions);
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
          const resolved = credentials.options();
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
      closing = http.close();
      return closing;
    },
  });
}
