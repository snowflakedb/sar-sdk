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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSarClient, type SarClient } from "../src/sar-client.js";
import { createConnectionOptions } from "../src/connection-options/index.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { createSecretsClient } from "../src/secrets-client/index.js";
import { integrationConnection } from "./connection.js";

/**
 * The first integration test: the SDK, the Node.js driver, and a real account together. It reads
 * only, creates no Snowflake object, and leaves nothing behind. Keep additions here cheap and
 * independent of account contents.
 */
describe("a client against a real account", () => {
  let client: SarClient;

  beforeAll(() => {
    const connectionOptions = createConnectionOptions(integrationConnection());
    const connections = createConnectionManager(connectionOptions);
    client = createSarClient({
      queryClient: createQueryClient(connections),
      fetchClient: createFetchClient(connectionOptions),
      secretsClient: createSecretsClient(),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("opens and releases a session", async () => {
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it("reads the server version", async () => {
    const result = await client.query<{ VERSION: string }>("SELECT CURRENT_VERSION() AS VERSION");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.columns.map((column) => column.name)).toEqual(["VERSION"]);
    expect(result.rowCount).toBe(1);
    expect(result.queryId).not.toBe("");
  });

  it("round trips a bind", async () => {
    const result = await client.query<{ VALUE: string }>("SELECT ?::VARCHAR AS VALUE", {
      binds: ["Hello from the SAR SDK"],
    });

    expect(result.rows).toEqual([{ VALUE: "Hello from the SAR SDK" }]);
  });
});
