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

import { createSarClient, isSarError } from "@snowflake/sar-sdk";
import { createConnectionOptions, fromToml } from "@snowflake/sar-sdk/auth";

// Call explicitly in your server/script. Importing this example performs no work.
export async function queryExample(): Promise<void> {
  const options = createConnectionOptions(fromToml({ name: "dev" }));
  const client = createSarClient({ connectionOptions: options });
  try {
    const result = await client.query<{ MESSAGE: string }>("SELECT ?::VARCHAR AS MESSAGE", {
      binds: ["Hello from SAR"],
      signal: AbortSignal.timeout(10_000),
    });
    console.log(result.rows, result.queryId);
  } catch (error) {
    if (isSarError(error)) console.error(error.toJSON());
    else throw error;
  } finally {
    await client.close();
    await options.close();
  }
}
