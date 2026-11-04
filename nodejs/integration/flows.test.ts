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
import { isSarError } from "../src/index.js";
import { createSarClient, type SarClient } from "../src/sar-client.js";
import {
  createConnectionOptions,
  type ConnectionOptionsFactoryOptions,
} from "../src/connection-options/index.js";
import { createConnectionManager, type PoolOptions } from "../src/connection-manager/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { createQueryClient, type QueryClientOptions } from "../src/query-client/index.js";
import { createSecretsClient } from "../src/secrets-client/index.js";
import { integrationConnection } from "./connection.js";

/**
 * The SDK's main flows against a real account, one test each. Like query.test.ts, these read only
 * and create no Snowflake object. They also need no warehouse, which the test user may not have:
 * multi-row results come from SHOW FUNCTIONS, and the long-running query is SYSTEM$WAIT.
 */
// In LIKE, `_` matches any one character, so this also returns ARRAYS_OVERLAP and similar.
const MULTI_ROW = "SHOW FUNCTIONS LIKE 'ARRAY_%'";
/** A client composed from its components, each taking the settings it owns. */
function composedClient(
  settings: {
    connection?: ConnectionOptionsFactoryOptions;
    pool?: PoolOptions;
    results?: QueryClientOptions["results"];
  } = {},
): SarClient {
  const connectionOptions = createConnectionOptions(integrationConnection(), settings.connection);
  const connections = createConnectionManager(
    connectionOptions,
    settings.pool ? { pool: settings.pool } : {},
  );
  return createSarClient({
    queryClient: createQueryClient(
      connections,
      settings.results ? { results: settings.results } : {},
    ),
    fetchClient: createFetchClient(connectionOptions),
    secretsClient: createSecretsClient(),
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
/** Like rejection(), for calls that may also throw before returning a promise. */
const failure = (run: () => Promise<unknown>) => rejection(Promise.resolve().then(run));

describe("main flows against a real account", () => {
  let client: SarClient;

  beforeAll(() => {
    client = composedClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  it("streams rows and releases the session after an early exit", async () => {
    const names: string[] = [];
    for await (const row of await client.stream<{ name: string }>(MULTI_ROW)) names.push(row.name);
    expect(names.length).toBeGreaterThan(2);
    expect(names.every((name) => name.startsWith("ARRAY"))).toBe(true);

    for await (const row of await client.stream(MULTI_ROW)) {
      void row;
      break;
    }
    expect((await client.diagnostics()).activeConnections).toBe(0);
  });

  it("fails closed when a result exceeds maxRows", async () => {
    const error = await rejection(client.query(MULTI_ROW, { maxRows: 2 }));
    expect(isSarError(error) && error.code).toBe("RESULT_LIMIT_EXCEEDED");
  });

  it("keeps a 38-digit number exact with numbers: 'string'", async () => {
    const exact = composedClient({ results: { numbers: "string" } });
    try {
      const { rows } = await exact.query<{ BIG: string }>(
        "SELECT 12345678901234567890123456789012345678::NUMBER(38, 0) AS BIG",
      );
      expect(rows[0]?.BIG).toBe("12345678901234567890123456789012345678");
    } finally {
      await exact.close();
    }
  });

  it("reports Snowflake's error code for a failed statement", async () => {
    const error = await rejection(client.query("SELECT * FROM SAR_SDK_INTEGRATION_NO_SUCH_TABLE"));
    expect(error).toMatchObject({ code: "QUERY_FAILED", details: { errorCode: "002003" } });
  });

  it("runs a transaction's statements in one transaction and rolls back on a throw", async () => {
    const ids = await client.transaction(async (tx) => {
      const first = await tx.query<{ T: string }>("SELECT CURRENT_TRANSACTION() AS T");
      const second = await tx.query<{ T: string }>("SELECT CURRENT_TRANSACTION() AS T");
      return [first.rows[0]?.T, second.rows[0]?.T];
    });
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);

    const failure = new Error("synthetic application failure");
    const thrown = await rejection(
      client.transaction(async (tx) => {
        await tx.query("SELECT 1");
        throw failure;
      }),
    );
    expect(thrown).toBe(failure);
  });

  it("submits a detached query and reads its result from another client", async () => {
    const reference = await client.submitDetached("SELECT 42 AS ANSWER");
    let outcome = await client.pollQuery<{ ANSWER: number }>(reference);
    for (let i = 0; outcome.status === "pending" && i < 30; i++) {
      await sleep(1000);
      outcome = await client.pollQuery(reference);
    }
    expect(outcome.status).toBe("complete");
    expect(outcome.status === "complete" && Number(outcome.result.rows[0]?.ANSWER)).toBe(42);

    // A reference is plain data: another process can read the result after a round trip.
    const replica = composedClient();
    try {
      const copy = JSON.parse(JSON.stringify(reference));
      expect(await replica.getQueryStatus(copy)).toBe("SUCCESS");
      const streamed = await replica.streamQuery<{ ANSWER: number }>(copy);
      expect(streamed.status).toBe("complete");
      const rows = [];
      if (streamed.status === "complete") for await (const row of streamed.stream) rows.push(row);
      expect(rows.map((row) => Number(row.ANSWER))).toEqual([42]);
    } finally {
      await replica.close();
    }
  });

  it("cancels a running detached query", async () => {
    const reference = await client.submitDetached("SELECT SYSTEM$WAIT(120) AS WAITED");
    await sleep(2000);
    const cancellation = await client.cancelQuery(reference);
    expect(cancellation).toEqual({ queryId: reference.queryId, cancelled: true });
  });

  it("reuses a bounded pool of sessions under concurrent queries", async () => {
    const pooled = composedClient({
      pool: { mode: "reusable", maxConnections: 2, reset: async () => {} },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          pooled.query<{ I: number }>("SELECT ? AS I", { binds: [i] }),
        ),
      );
      expect(results.map((result) => Number(result.rows[0]?.I))).toEqual(
        Array.from({ length: 20 }, (_, i) => i),
      );
      expect((await pooled.diagnostics()).physicalConnections).toBeLessThanOrEqual(2);
    } finally {
      await pooled.close();
    }
    expect((await pooled.diagnostics()).physicalConnections).toBe(0);
  });

  it("lends the driver's connection to withConnection", async () => {
    const user = await client.withConnection(
      (connection) =>
        new Promise<string>((resolve, reject) => {
          connection.execute({
            sqlText: "SELECT CURRENT_USER() AS U",
            complete: (error, _statement, rows) =>
              error ? reject(error) : resolve(String((rows as { U: string }[])[0]?.U)),
          });
        }),
    );
    expect(user).not.toBe("");
  });

  it("refuses a caller view without caller context, and runs it as the owner with callerAsOwner", async () => {
    const missing = await failure(() =>
      client.asCaller({ headers: new Headers() }).query("SELECT 1"),
    );
    expect(isSarError(missing) && missing.code).toBe("CALLER_CONTEXT_REQUIRED");

    const local = composedClient({ connection: { callerAsOwner: true } });
    try {
      const owner = await local.query<{ U: string }>("SELECT CURRENT_USER() AS U");
      const caller = await local
        .asCaller({ headers: new Headers() })
        .query<{ U: string }>("SELECT CURRENT_USER() AS U");
      expect(caller.rows[0]?.U).toBe(owner.rows[0]?.U);
    } finally {
      await local.close();
    }
  });
});
