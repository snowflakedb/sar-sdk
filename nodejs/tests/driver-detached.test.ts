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

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const load = createRequire(path.join(process.cwd(), "package.json"));
const base = path.dirname(load.resolve("snowflake-sdk"));
// Pinned-driver characterization only. Production uses public Connection methods.
const SnowflakeService = load(path.join(base, "lib/services/sf.js"));
const RowStream = load(path.join(base, "lib/connection/result/row_stream.js"));

describe("pinned driver detached-session contract", () => {
  it.each([true, false])(
    "serverSessionKeepAlive=%s controls server session deletion",
    async (serverSessionKeepAlive) => {
      const request = vi.fn((options) => {
        void options.callback(undefined, { statusCode: 200 }, { success: true });
      });
      const service = new SnowflakeService(
        {
          serverSessionKeepAlive,
          accessUrl: "https://synthetic.invalid",
          getAuthenticator: () => "OAUTH",
          getToken: () => "synthetic-login",
        },
        { request },
        {
          tokenInfo: {
            sessionToken: "synthetic-session",
            masterToken: "synthetic-master",
            sessionTokenExpirationTime: Date.now() + 60_000,
            masterTokenExpirationTime: Date.now() + 60_000,
          },
        },
      );
      expect(service.isConnected()).toBe(true);
      await new Promise<void>((resolve, reject) =>
        service.destroy({ callback: (error?: Error) => (error ? reject(error) : resolve()) }),
      );
      expect(service.isConnected()).toBe(false);
      expect(request).toHaveBeenCalledTimes(serverSessionKeepAlive ? 0 : 1);
      if (!serverSessionKeepAlive)
        expect(request.mock.calls[0]?.[0].url).toContain("/session?delete=true");
      expect(service.getConfig().tokenInfo.sessionToken).toBeUndefined();
    },
  );
  it("does not promise cancellation of in-flight chunk downloads when a row stream is destroyed", async () => {
    const loaded = new EventEmitter();
    const first = Object.assign(loaded, {
      isLoading: () => false,
      load: vi.fn(),
      getStartIndex: () => 0,
      getEndIndex: () => 0,
      getRows: () => [{ values: ["value"] }],
      clearRows: vi.fn(),
    });
    const second = { isLoading: () => false, load: vi.fn() };
    const stream = new RowStream(
      { getColumns: () => [] },
      {
        rowMode: "array",
        fetchAsString: [],
        connectionConfig: { rowStreamHighWaterMark: 1, getResultPrefetch: () => 1 },
        result: { getReturnedRows: () => 2, findOverlappingChunks: () => [first, second] },
      },
    );
    stream.on("error", () => {});
    stream.read();
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(first.load).toHaveBeenCalledOnce();
    expect(second.load).toHaveBeenCalledOnce();
    stream.destroy();
    expect(stream.destroyed).toBe(true);
    // The driver's internal loader still owns its callback; there is no public cancel hook.
    expect(first.listenerCount("loadcomplete")).toBe(1);
    first.removeAllListeners();
  });
});
