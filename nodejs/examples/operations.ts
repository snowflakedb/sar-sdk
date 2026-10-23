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
import { fromTokenFile, type AuthProvider } from "@snowflake/sar-sdk/auth";

export function tokenProvider(): AuthProvider {
  return fromTokenFile({
    id: "deployment",
    path: "/run/company/snowflake-token",
    type: "oauth",
    target: { account: "org-account" },
  });
}

export async function handleExample(client: SarClient): Promise<void> {
  const handle = await client.submit("SELECT CURRENT_TIMESTAMP() AS NOW");
  try {
    const result = await handle.result({ waitTimeoutMs: 30_000 });
    console.log(result.queryId, result.rowCount);
  } finally {
    await handle.cancel();
  }
}

export async function transactionExample(client: SarClient): Promise<void> {
  await client.transaction(async (tx) => {
    await tx.query("UPDATE ACCOUNTS SET BALANCE = BALANCE - ? WHERE ID = ?", { binds: [100, "A"] });
    await tx.query("UPDATE ACCOUNTS SET BALANCE = BALANCE + ? WHERE ID = ?", { binds: [100, "B"] });
  });
}

export async function streamExample(client: SarClient): Promise<void> {
  const stream = await client.stream("SELECT CURRENT_USER() AS USER_NAME");
  try {
    for await (const row of stream) console.log(row);
  } finally {
    await stream.close();
  }
}

export async function httpExample(client: SarClient): Promise<unknown> {
  const response = await client.fetch("/api/v2/warehouses", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Account API returned HTTP ${response.status}`);
  }
  return response.json();
}
