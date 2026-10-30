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

import { fail, keys } from "../core/errors.js";

/** Structural interface implemented by Web Headers and Next.js request headers. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}
/** Exactly one source is required. A supplied empty token is invalid. */
export type CallerContext =
  { headers: HeaderReader; token?: never } | { token: string; headers?: never };

/** Extracts caller context; it does not validate the token or authenticate ingress. */
export function getCallerUserToken(headers: HeaderReader): string | null {
  const token = headers.get("sf-context-current-user-token");
  if (token === null || token === undefined) return null;
  if (typeof token !== "string" || !token.trim())
    fail("CALLER_CONTEXT_REQUIRED", "Present caller token cannot be empty");
  return token;
}

export function callerToken(context: CallerContext): string | null {
  keys(context, ["headers", "token"], "caller");
  if ("headers" in context === "token" in context)
    fail("INVALID_OPTIONS", "Supply exactly one of headers or token");
  if ("token" in context) {
    if (typeof context.token !== "string" || !context.token.trim())
      fail("CALLER_CONTEXT_REQUIRED", "Explicit caller token cannot be empty");
    return context.token;
  }
  if (!context.headers || typeof context.headers.get !== "function")
    fail("INVALID_OPTIONS", "Caller headers must provide get(name)");
  return getCallerUserToken(context.headers);
}
