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
  isSarError,
  type CallerClient,
  type QueryReference,
  type RowStream,
  type SarClient,
} from "@snowflake/sar-sdk";

export interface QueryRecord {
  application: string;
  subject: string;
  expiresAt: number;
  decoder: "identity-v1";
  reference: QueryReference;
}

/** Supply durable, shared storage; an in-process Map cannot serve other instances. */
export interface QueryRecords {
  insert(record: QueryRecord): Promise<void>;
  get(queryId: string): Promise<QueryRecord | undefined>;
}

/** Populate with trusted server configuration, not values taken from a request body. */
export interface DetachedHttpDependencies {
  client: SarClient;
  application: string;
  mode: "owner" | "caller";
  records: QueryRecords;
  /** Verify ingress/session authentication and permission to use this application. */
  authenticate(request: Request): Promise<{ subject: string }>;
  /** Enforce application-wide job quotas before submission, across all replicas. */
  admit(subject: string): Promise<void>;
}

function decodeIdentity(row: unknown): { USER_NAME: string } {
  if (!row || typeof row !== "object" || !("USER_NAME" in row) || typeof row.USER_NAME !== "string")
    throw new Error("Unexpected identity result");
  return { USER_NAME: row.USER_NAME };
}

function unavailable(): Response {
  // Deliberately do not reveal whether another subject owns the query ID.
  return Response.json({ error: "Query unavailable" }, { status: 404 });
}

function inaccessible(error: unknown): boolean {
  return isSarError(error) && ["QUERY_UNAVAILABLE", "QUERY_IDENTITY_MISMATCH"].includes(error.code);
}

/** A failed read errors the body, so a truncated download never looks complete. */
function jsonLines(stream: RowStream<unknown>): ReadableStream<Uint8Array> {
  const rows = stream[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const next = await rows.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    cancel: () => stream.close(),
  });
}

export function detachedHttpHandlers(dependencies: DetachedHttpDependencies) {
  function scope(request: Request): CallerClient {
    return dependencies.mode === "caller"
      ? dependencies.client.asCaller({ headers: request.headers })
      : dependencies.client;
  }
  async function authorized(request: Request, queryId: string) {
    const { subject } = await dependencies.authenticate(request);
    const record = await dependencies.records.get(queryId);
    if (
      !record ||
      record.subject !== subject ||
      record.application !== dependencies.application ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Date.now() ||
      record.decoder !== "identity-v1" ||
      record.reference.queryId !== queryId ||
      record.reference.mode !== dependencies.mode
    )
      return undefined;
    return record;
  }
  async function respond(client: CallerClient, record: QueryRecord, signal: AbortSignal) {
    try {
      const result = await client.pollQuery<{ USER_NAME: string }>(record.reference, {
        signal,
        decodeRow: decodeIdentity,
      });
      return Response.json(result, { status: result.status === "pending" ? 202 : 200 });
    } catch (error) {
      if (inaccessible(error)) return unavailable();
      // The framework's error boundary handles disconnects and other failures without exposing causes.
      throw error;
    }
  }
  return {
    async submit(request: Request): Promise<Response> {
      const { subject } = await dependencies.authenticate(request);
      await dependencies.admit(subject);
      const client = scope(request);
      // Keep SQL and result policy on the server. Bind validated input for real reports.
      const reference = await client.submitDetached("SELECT CURRENT_USER() AS USER_NAME", {
        executionTimeoutMs: 60_000,
        signal: request.signal,
      });
      const record: QueryRecord = {
        application: dependencies.application,
        subject,
        expiresAt: Date.now() + 60 * 60 * 1_000,
        decoder: "identity-v1",
        reference,
      };
      try {
        // Do not tie this durable write to the request signal after acknowledgement.
        await dependencies.records.insert(record);
      } catch (error) {
        await client.cancelQuery(reference).catch(() => {});
        throw error;
      }
      return Response.json({ status: "pending", queryId: reference.queryId }, { status: 202 });
    },
    async poll(request: Request, queryId: string): Promise<Response> {
      const record = await authorized(request, queryId);
      return record ? respond(scope(request), record, request.signal) : unavailable();
    },
    /** Streams a completed result as JSON lines, without the reference's row and byte limits. */
    async download(request: Request, queryId: string): Promise<Response> {
      const record = await authorized(request, queryId);
      if (!record) return unavailable();
      try {
        const outcome = await scope(request).streamQuery<{ USER_NAME: string }>(record.reference, {
          signal: request.signal,
          decodeRow: decodeIdentity,
        });
        if (outcome.status === "pending") return Response.json(outcome, { status: 202 });
        return new Response(jsonLines(outcome.stream), {
          headers: { "content-type": "application/x-ndjson" },
        });
      } catch (error) {
        if (inaccessible(error)) return unavailable();
        throw error;
      }
    },
    async cancel(request: Request, queryId: string): Promise<Response> {
      const record = await authorized(request, queryId);
      if (!record) return unavailable();
      try {
        const outcome = await scope(request).cancelQuery(record.reference, {
          signal: request.signal,
        });
        // A query that finished first wasn't cancelled; its result or failure can still be polled.
        return Response.json(outcome, { status: outcome.cancelled ? 202 : 409 });
      } catch (error) {
        if (inaccessible(error)) return unavailable();
        throw error;
      }
    },
  };
}
