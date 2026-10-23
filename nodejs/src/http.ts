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
  EnvHttpProxyAgent,
  fetch as transportFetch,
  type RequestInit as TransportInit,
} from "undici";
import { SarError, fail } from "./errors.js";
import type { FetchInit } from "./types.js";

/**
 * The deadline and shutdown signal remain attached to the original response body
 * after headers arrive. Callers must consume or cancel that body. close() aborts
 * requests and bodies and destroys the dispatcher; it does not drain responses.
 */
export class HttpTransport {
  private agent?: EnvHttpProxyAgent;
  private readonly shutdown = new AbortController();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly timeoutMs = 120_000) {}

  async fetch(url: string, init: FetchInit = {}): Promise<Response> {
    if (this.closed) fail("CLIENT_CLOSED", "HTTP transport is closed");
    const { timeoutMs = this.timeoutMs, ...request } = init;
    const callerSignal = request.signal;
    if (callerSignal != null && !(callerSignal instanceof AbortSignal))
      fail("INVALID_OPTIONS", "HTTP signal must be an AbortSignal");
    if (callerSignal?.aborted) fail("ABORTED", "HTTP request was aborted");
    try {
      this.agent ??= new EnvHttpProxyAgent();
    } catch {
      // Proxy URLs come from the environment and may embed credentials, which URL errors quote.
      fail("HTTP_FAILED", "HTTP proxy settings are invalid");
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([
      deadline,
      this.shutdown.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      const response = await transportFetch(url, {
        ...request,
        body: request.body as TransportInit["body"],
        dispatcher: this.agent,
        redirect: "error",
        signal,
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      return response as unknown as Response;
    } catch (error) {
      if (this.closed) fail("CLIENT_CLOSED", "HTTP transport is closed");
      if (callerSignal?.aborted) fail("ABORTED", "HTTP request was aborted");
      if (deadline.aborted) fail("TIMEOUT", "HTTP request deadline exceeded");
      throw new SarError("HTTP_FAILED", "HTTP request failed", {}, error);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const agent = this.agent;
    this.agent = undefined;
    this.closing = Promise.resolve().then(async () => {
      try {
        await agent?.destroy();
      } catch {
        fail("HTTP_FAILED", "HTTP transport shutdown failed");
      }
    });
    this.shutdown.abort(new SarError("CLIENT_CLOSED", "HTTP transport is closed"));
    return this.closing;
  }
}

export function relativeAccountUrl(origin: string, pathname: string): string {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters and spaces in paths
    /[\u0000-\u0020]/.test(pathname)
  )
    fail(
      "INVALID_OPTIONS",
      "REST path must be an origin-relative path without whitespace or backslashes",
    );
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.hash || url.username || url.password)
    fail("INVALID_OPTIONS", "REST request must stay on the selected account origin");
  return url.href;
}
