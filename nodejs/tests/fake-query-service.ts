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

import { Readable } from "node:stream";
import { vi } from "vitest";
import type snowflake from "snowflake-sdk";
import type { DriverModule, QueryIdentity } from "../src/types.js";
import { failedQueryError } from "./fake-driver.js";

export type SyntheticQuery = {
  status: string;
  identity: QueryIdentity;
  rows: unknown[][];
  names: string[];
  types: string[];
  error?: Error;
};
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A synthetic server shared by independent SDK clients; not application job storage. */
export function fakeQueryService() {
  const queries = new Map<string, SyntheticQuery>();
  const settings = {
    identity: {
      organization: "ORG",
      account: "ACCOUNT",
      user: "USER",
      role: "ROLE",
    } as QueryIdentity,
    status: "RUNNING",
    abortDetached: "false",
    autocommit: "true",
    statementTimeout: "172800",
    rows: [["9007199254740993"]] as unknown[][],
    names: ["VALUE"],
    types: ["fixed"],
    updatedRows: -1,
    connectGate: undefined as Promise<void> | undefined,
    submitGate: undefined as Promise<void> | undefined,
    statusGate: undefined as Promise<void> | undefined,
    fetchGate: undefined as Promise<void> | undefined,
    controlGate: undefined as Promise<void> | undefined,
    destroyGate: undefined as Promise<void> | undefined,
    connectError: undefined as Error | undefined,
    submitError: undefined as Error | undefined,
    executeThrows: false,
    statusError: undefined as Error | undefined,
    queryError: undefined as Error | undefined,
    fetchError: undefined as Error | undefined,
    fetchedQueryId: undefined as string | undefined,
    controlError: undefined as Error | undefined,
    cancelError: undefined as Error | undefined,
    destroyError: undefined as Error | undefined,
    readable: undefined as Readable | undefined,
    identityRows: undefined as unknown[] | undefined,
    missingParameter: false,
    missingQueryId: false,
    acknowledgementIdError: false,
    cancelResponse: undefined as unknown[] | undefined,
    cancelKeepsRunning: false,
    cancelledStatus: "ABORTED" as "ABORTED" | "FAILED_WITH_ERROR",
    onAcknowledged: undefined as (() => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    onStatus: undefined as (() => void) | undefined,
    onFetch: undefined as (() => void) | undefined,
  };
  const connections: {
    config: snowflake.ConnectionOptions;
    execute: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    getQueryStatus: ReturnType<typeof vi.fn>;
    getQueryStatusThrowIfError: ReturnType<typeof vi.fn>;
    fetchResult: ReturnType<typeof vi.fn>;
    streams: Readable[];
  }[] = [];
  let sequence = 0;
  function markCancelled(query: SyntheticQuery) {
    query.status = settings.cancelledStatus;
    if (query.status === "FAILED_WITH_ERROR")
      query.error = failedQueryError("000604", "SQL execution canceled", "synthetic");
  }
  const driver: DriverModule = {
    createConnection(config) {
      const identity = { ...settings.identity };
      const ownedIds: string[] = [];
      const streams: Readable[] = [];
      let sessionLimit = settings.statementTimeout;
      const cancel = vi.fn((callback: (error?: Error) => void) => {
        if (!settings.cancelError)
          for (const queryId of ownedIds) markCancelled(queries.get(queryId)!);
        callback(settings.cancelError);
      });
      function statementFor(
        queryId: string,
        ready: () => boolean = () => true,
      ): snowflake.RowStatement {
        return {
          getQueryId: () => queryId,
          cancel,
          getColumns: () =>
            ready()
              ? (queries.get(queryId)?.names ?? []).map((name, index) => ({
                  getName: () => name,
                  getType: () => queries.get(queryId)!.types[index] ?? "text",
                  getPrecision: () => 38,
                  getScale: () => 0,
                  isNullable: () => true,
                }))
              : undefined,
          getNumUpdatedRows: () => settings.updatedRows,
          streamRows: () => {
            const stream =
              settings.readable ??
              Readable.from(queries.get(queryId)?.rows ?? [], { objectMode: true });
            streams.push(stream);
            return stream;
          },
        } as unknown as snowflake.RowStatement;
      }
      const execute = vi.fn((execution: snowflake.StatementOption) => {
        let queryId = "00000000-0000-0000-0000-000000000000";
        let result: unknown[] = [];
        let gate = settings.controlGate;
        let error = settings.controlError;
        if (execution.asyncExec) {
          if (settings.executeThrows) throw Error("private synchronous execute failure");
          queryId = settings.missingQueryId
            ? ""
            : `01000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
          queries.set(queryId, {
            status: settings.status,
            identity,
            rows: settings.rows,
            names: settings.names,
            types: settings.types,
          });
          ownedIds.push(queryId);
          gate = settings.submitGate;
          error = settings.submitError;
        } else if (execution.sqlText.startsWith("SELECT CURRENT_ORGANIZATION_NAME")) {
          result = settings.identityRows ?? [identity];
        } else if (execution.sqlText.startsWith("SHOW PARAMETERS")) {
          const name = execution.sqlText.match(/LIKE '([^']+)'/)![1]!;
          const values: Record<string, string> = {
            ABORT_DETACHED_QUERY: settings.abortDetached,
            AUTOCOMMIT: settings.autocommit,
            STATEMENT_TIMEOUT_IN_SECONDS: sessionLimit,
          };
          result = settings.missingParameter ? [] : [{ key: name, value: values[name] }];
        } else if (execution.sqlText.startsWith("ALTER SESSION SET")) {
          sessionLimit =
            execution.sqlText.match(/STATEMENT_TIMEOUT_IN_SECONDS = (\d+)/)?.[1] ?? sessionLimit;
        } else if (execution.sqlText.startsWith("SELECT SYSTEM$CANCEL_QUERY")) {
          const target = queries.get((execution.binds as string[])[0]!);
          error = settings.cancelError;
          if (!error && target && !settings.cancelKeepsRunning) markCancelled(target);
          settings.onCancel?.();
          result = settings.cancelResponse ?? [
            { status: `query [${(execution.binds as string[])[0]}] terminated.` },
          ];
        }
        const statement = statementFor(queryId);
        void (gate ?? Promise.resolve()).then(() => {
          const completed =
            execution.asyncExec && settings.acknowledgementIdError
              ? ({
                  getQueryId() {
                    throw Error("synthetic acknowledgement failure");
                  },
                } as unknown as snowflake.RowStatement)
              : statement;
          execution.complete?.(error as snowflake.SnowflakeError | undefined, completed, result);
          if (execution.asyncExec) settings.onAcknowledged?.();
        });
        return statement;
      });
      const connect = vi.fn((callback: (error?: Error) => void) => {
        void (settings.connectGate ?? Promise.resolve()).then(() =>
          callback(settings.connectError),
        );
      });
      const destroy = vi.fn((callback: (error?: Error) => void) => {
        void (settings.destroyGate ?? Promise.resolve()).then(() => {
          if (!config.serverSessionKeepAlive)
            for (const queryId of ownedIds) {
              const query = queries.get(queryId)!;
              if (query.status === "RUNNING") query.status = "ABORTED";
            }
          callback(settings.destroyError);
        });
      });
      const getQueryStatus = vi.fn(async (queryId: string) => {
        if (settings.statusGate) await settings.statusGate;
        if (settings.statusError) throw settings.statusError;
        settings.onStatus?.();
        return queries.get(queryId)?.status ?? "NO_QUERY_DATA";
      });
      const getQueryStatusThrowIfError = vi.fn(async (queryId: string) => {
        const error = settings.queryError ?? queries.get(queryId)?.error;
        if (error) throw error;
        return queries.get(queryId)?.status ?? "NO_QUERY_DATA";
      });
      const fetchResult = vi.fn(
        (execution: { queryId: string } & Partial<snowflake.StatementOption>) => {
          let ready = false;
          const statement = statementFor(settings.fetchedQueryId ?? execution.queryId, () => ready);
          void (settings.fetchGate ?? Promise.resolve()).then(() => {
            ready = true;
            execution.complete?.(
              settings.fetchError as snowflake.SnowflakeError | undefined,
              statement,
              undefined,
            );
            settings.onFetch?.();
          });
          return statement;
        },
      );
      connections.push({
        config,
        execute,
        connect,
        destroy,
        cancel,
        getQueryStatus,
        getQueryStatusThrowIfError,
        fetchResult,
        streams,
      });
      return {
        connect,
        destroy,
        execute,
        getQueryStatus,
        getQueryStatusThrowIfError,
        fetchResult,
      } as unknown as snowflake.Connection;
    },
  };
  return { driver, connections, queries, settings };
}
