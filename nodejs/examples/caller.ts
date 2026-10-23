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

import type { SarClient } from "@snowflake/sar-sdk";

/** Supply headers only from your trusted Snowflake ingress, not public request input. */
export async function callerExample(client: SarClient, request: Request): Promise<Response> {
  const caller = client.asCaller({ headers: request.headers });
  const result = await caller.query("SELECT CURRENT_USER() AS USER_NAME", {
    signal: request.signal,
  });
  return Response.json(result);
}

export async function rawCallerExample(client: SarClient, request: Request): Promise<string> {
  return client.asCaller({ headers: request.headers }).withConnection(async (connection) => {
    // Await all driver work here; do not retain or destroy this connection.
    return connection.getId();
  });
}
