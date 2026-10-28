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

import { createConnectionOptions, fromDefault } from "@snowflake/sar-sdk/auth";
import { createConnectionManager } from "@snowflake/sar-sdk/connections";
import { createQueryClient } from "@snowflake/sar-sdk/query";
import { createFetchClient } from "@snowflake/sar-sdk/http";
import { createSecrets } from "@snowflake/sar-sdk/secrets";
import type { Connection } from "@snowflake/sar-sdk/driver";

function execute(connection: Connection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      complete(error) {
        if (error) reject(error);
        else resolve();
      },
    });
  });
}
export async function compositionExample(headers: Headers): Promise<void> {
  // Your application chooses the connection options; the components share them and never close them.
  const auth = createConnectionOptions(fromDefault(), {
    callerAsOwner: process.env.NODE_ENV === "development",
  });
  const connections = createConnectionManager(auth);
  const queries = createQueryClient(connections);
  const http = createFetchClient(auth);
  const secrets = createSecrets();
  try {
    const result = await queries.query("SELECT CURRENT_USER() AS USER_NAME");
    console.log(result.rows);
    await connections.asCaller({ headers }).withConnection(async (connection) => {
      await execute(connection, "SELECT CURRENT_USER()");
    });
    await (await http.fetch("/api/v2/warehouses")).body?.cancel();
    await secrets.getString("API_KEY");
  } finally {
    await Promise.all([queries.close(), connections.close(), http.close(), secrets.close()]);
  }
}

/** Only for an application restricted to read-only SQL and this exact session-state contract. */
export async function reuseExample(): Promise<void> {
  const connections = createConnectionManager(createConnectionOptions(fromDefault()), {
    pool: {
      mode: "reusable",
      maxConnections: 4,
      idleTimeoutMs: 30_000,
      maxLifetimeMs: 600_000,
      async reset(connection) {
        // Not a universal reset: this example never creates temp objects, changes context,
        // or sets session variables. Use isolated mode for unconstrained native SQL.
        await execute(connection, "ROLLBACK");
      },
    },
  });
  try {
    await connections.withConnection(async (connection) => {
      await execute(connection, "SELECT 1");
    });
  } finally {
    await connections.close();
  }
}
