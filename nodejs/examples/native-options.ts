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

import snowflake from "snowflake-sdk";
import {
  createConnectionOptions,
  fromPlatform,
  fromToml,
  getCallerUserToken,
} from "@snowflake/sar-sdk/auth";
import type { Connection } from "@snowflake/sar-sdk/driver";

function execute(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: "SELECT CURRENT_USER()",
      complete(error) {
        if (error) reject(error);
        else resolve();
      },
    });
  });
}

/** Direct native-driver lifecycle; no SDK result conversion or query limits. */
export async function nativeOptionsExample(headers: Headers): Promise<void> {
  const options = createConnectionOptions(fromPlatform());
  const callerToken = getCallerUserToken(headers);
  if (!callerToken) throw new Error("The request carries no caller token");
  // The native options contain credentials; keep them out of logs and responses.
  const connection: Connection = snowflake.createConnection(options.getCallerOptions(callerToken));
  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((error) => (error ? reject(error) : resolve()));
    });
    await execute(connection);
  } finally {
    await new Promise<void>((resolve, reject) => {
      connection.destroy((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** A native pool captures one snapshot. Not a rotation-aware long-lived pool. */
export async function nativePoolExample(): Promise<void> {
  const options = createConnectionOptions(fromToml({ name: "development" }));
  const pool = snowflake.createPool(options.getOwnerOptions(), { min: 0, max: 2 });
  try {
    await pool.use(execute);
  } finally {
    await pool.drain();
    await pool.clear();
  }
}
