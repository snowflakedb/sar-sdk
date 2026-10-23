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

import type snowflake from "snowflake-sdk";
import { defined, isSarError, SarError, snowflakeDetails } from "./errors.js";
import { deadline } from "./lifecycle.js";

/** 3.3.0 connectAsync can fulfill after reporting a callback-only login error. */
export function connect(connection: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.connect((error) => (error ? reject(error) : resolve()));
  });
}

export function destroy(connection: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.destroy((error) => (error ? reject(error) : resolve()));
  });
}

/** For a query already observed as SUCCESS; getResultsFromQueryId would check its status again. */
export function fetchResult(
  connection: snowflake.Connection,
  queryId: string,
  options: Partial<snowflake.StatementOption>,
): Promise<snowflake.RowStatement> {
  return new Promise((resolve, reject) => {
    connection.fetchResult({
      ...options,
      queryId,
      complete(error, statement) {
        if (error) reject(error);
        else if (statement.getQueryId()?.toLowerCase() !== queryId.toLowerCase())
          reject(new SarError("QUERY_FAILED", "Result lookup returned a different query ID"));
        else resolve(statement);
      },
    });
  });
}

const failures = new Set(["FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"]);

/** Unknown, BLOCKED, ABORTING and disconnected observations do not prove completion. */
export function queryState(status: string): "succeeded" | "failed" | "pending" {
  if (status === "SUCCESS") return "succeeded";
  return failures.has(status) ? "failed" : "pending";
}

/** The driver reports a failed query's code and message in the monitoring response, not its own fields. */
function serverReason(error: unknown): { errorCode?: string; message?: string } {
  if (!(error instanceof Error) || isSarError(error)) return {};
  const query = (
    error as { data?: { data?: { queries?: { errorCode?: unknown; errorMessage?: unknown }[] } } }
  ).data?.data?.queries?.[0];
  if (!query) return {};
  const errorCode =
    typeof query.errorCode === "string" && /^\d{3,6}$/.test(query.errorCode)
      ? query.errorCode
      : undefined;
  const message =
    typeof query.errorMessage === "string" && query.errorMessage ? query.errorMessage : undefined;
  return { errorCode, message };
}

/**
 * Error for a query the server reported as failed. Only the numeric code is serialized: the
 * message can quote SQL literals, so it stays in the cause, and the driver's monitoring response,
 * which repeats the SQL text, is not retained.
 */
/** For a statement Snowflake ran and rejected; its message can quote SQL, so only the cause has it. */
export function statementFailure(
  error: unknown,
  queryId: string | undefined,
): SarError | undefined {
  if (!queryId || !(error instanceof Error) || isSarError(error)) return undefined;
  const { errorCode, sqlState } = snowflakeDetails(error);
  if (!errorCode) return undefined;
  return new SarError(
    "QUERY_FAILED",
    `Snowflake query did not succeed (error ${errorCode})`,
    defined({ queryId, completion: "failed" as const, errorCode, sqlState }),
    Object.assign(new Error(error.message), { code: errorCode }),
  );
}
export async function failedQuery(
  connection: snowflake.Connection,
  queryId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SarError> {
  let reason: ReturnType<typeof serverReason> = {};
  if (typeof connection.getQueryStatusThrowIfError === "function") {
    try {
      await deadline(
        connection.getQueryStatusThrowIfError(queryId),
        timeoutMs,
        signal,
        "Query failure lookup",
      );
    } catch (error) {
      reason = serverReason(error);
    }
  }
  return new SarError(
    "QUERY_FAILED",
    `Snowflake query did not succeed${reason.errorCode ? ` (error ${reason.errorCode})` : ""}`,
    defined({ queryId, completion: "failed" as const, errorCode: reason.errorCode }),
    reason.message === undefined
      ? undefined
      : Object.assign(new Error(reason.message), { code: reason.errorCode }),
  );
}
