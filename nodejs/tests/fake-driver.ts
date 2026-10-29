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
import { driverPool, type FakeDriverModule } from "./fake-pool.js";

type SyncReason = {
  data?: { data?: { queries?: { errorCode?: string; errorMessage?: string }[] } };
};

export function fakeDriver(
  options: {
    rows?: unknown[][];
    names?: string[];
    types?: string[];
    updatedRows?: number;
    status?: string;
    statuses?: string[];
    delay?: number;
    executeError?: Error;
    queryError?: Error;
    connectError?: Error;
    /** Thrown by createConnection, as the driver does for invalid options. */
    constructError?: Error;
    /** The query ID of a connection that isValidAsync reports as no longer usable. */
    invalid?: string;
    connectDelay?: number;
    connectGate?: Promise<void>;
    fetchGate?: Promise<void>;
    fetchError?: Error;
    fetchReject?: Error;
    missingMetadata?: boolean;
    cancelError?: Error;
    initializationError?: Error;
    destroyError?: Error;
    destroyGate?: Promise<void>;
    readable?: Readable;
    afterInitialization?: () => void;
    /** Keyed by exact SQL text, such as "COMMIT"; these take precedence over the options above. */
    sqlErrors?: Record<string, Error>;
    sqlGates?: Record<string, Promise<void>>;
  } = {},
) {
  const connections: {
    config: snowflake.ConnectionOptions;
    connect: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    getQueryStatus: ReturnType<typeof vi.fn>;
    fetchResult: ReturnType<typeof vi.fn>;
  }[] = [];
  const driver = {
    createConnection(connectionOptions: snowflake.ConnectionOptions) {
      // The driver copies options when it builds a connection.
      const config = { ...connectionOptions };
      if (options.constructError) throw options.constructError;
      const queryId = `query-${connections.length + 1}`;
      const cancel = vi.fn((callback: (error?: Error) => void) => callback(options.cancelError));
      let fetched = false;
      const statement = {
        getQueryId: () => queryId,
        getColumns: () =>
          !fetched || options.missingMetadata
            ? undefined
            : (options.names ?? ["VALUE"]).map((name, index) => ({
                getName: () => name,
                getType: () => options.types?.[index] ?? "fixed",
                getScale: () => 0,
                getPrecision: () => 38,
                isNullable: () => true,
              })),
        getNumUpdatedRows: () => options.updatedRows ?? -1,
        streamRows: () =>
          options.readable ??
          Readable.from(options.rows ?? [["9007199254740993"]], { objectMode: true }),
        cancel,
      } as unknown as snowflake.RowStatement;
      const execute = vi.fn((execution: snowflake.StatementOption) => {
        // A synchronous query completes when its results are ready, like the driver's.
        const sync = execution.streamResult === true && !execution.asyncExec;
        const final = options.statuses?.at(-1) ?? options.status ?? "SUCCESS";
        const complete = () => {
          const error =
            options.sqlErrors?.[execution.sqlText] ??
            (execution.sqlText.startsWith("ALTER SESSION SET")
              ? options.initializationError
              : options.executeError) ??
            (sync ? (options.fetchError ?? options.fetchReject ?? rejection(final)) : undefined);
          if (sync && !error) fetched = true;
          execution.complete?.(error as snowflake.SnowflakeError | undefined, statement, undefined);
          if (execution.sqlText.startsWith("ALTER SESSION SET")) options.afterInitialization?.();
        };
        const rejection = (status: string) => {
          if (!["FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"].includes(status)) return;
          const reason = (options.queryError as SyncReason | undefined)?.data?.data?.queries?.[0];
          return Object.assign(new Error(reason?.errorMessage ?? "driver-sensitive-error"), {
            name: "OperationFailedError",
            code: reason?.errorCode,
            data: { queryId, errorCode: reason?.errorCode },
          });
        };
        if (
          sync &&
          !["SUCCESS", "FAILED_WITH_ERROR", "FAILED_WITH_INCIDENT", "ABORTED"].includes(final)
        )
          return statement;
        const gate =
          options.sqlGates?.[execution.sqlText] ?? (sync ? options.fetchGate : undefined);
        if (gate) void gate.then(complete);
        else if (options.delay) setTimeout(complete, options.delay);
        else queueMicrotask(complete);
        return statement;
      });
      const destroy = vi.fn((callback: (error?: Error) => void) => {
        if (options.destroyGate)
          void options.destroyGate.then(() => callback(options.destroyError));
        else callback(options.destroyError);
      });
      let statusIndex = 0;
      const getQueryStatus = vi.fn(
        async () =>
          options.statuses?.[Math.min(statusIndex++, options.statuses.length - 1)] ??
          options.status ??
          "SUCCESS",
      );
      const connect = vi.fn((callback: (error?: Error) => void) => {
        void (async () => {
          if (options.connectGate) await options.connectGate;
          if (options.connectDelay)
            await new Promise((resolve) => setTimeout(resolve, options.connectDelay));
          callback(options.connectError);
        })().catch(callback);
      });
      const fetchResult = vi.fn((execution: snowflake.StatementOption) => {
        if (options.fetchReject) throw options.fetchReject;
        void (options.fetchGate ?? new Promise<void>((resolve) => setTimeout(resolve, 0))).then(
          () => {
            fetched = true;
            execution.complete?.(
              options.fetchError as snowflake.SnowflakeError | undefined,
              statement,
              undefined,
            );
          },
        );
        return statement;
      });
      connections.push({ config, connect, execute, destroy, cancel, getQueryStatus, fetchResult });
      return {
        connect,
        execute,
        destroy,
        getQueryStatus,
        isValidAsync: async () => options.invalid !== queryId,
        isStillRunning: (status: string) => status === "RUNNING",
        getQueryStatusThrowIfError: async () => {
          throw options.queryError ?? new Error("driver-sensitive-error");
        },
        fetchResult,
      } as unknown as snowflake.Connection;
    },
  } as FakeDriverModule;
  driver.createPool = driverPool(driver);
  return { driver, connections };
}

/** A DML summary row, with the count the pinned driver reports for it: every column summed. */
export function dmlSummary(summary: Record<string, string | number>) {
  const values = Object.values(summary);
  return {
    names: Object.keys(summary),
    types: values.map(() => "fixed"),
    rows: [values],
    updatedRows: values.reduce<number>((total, value) => total + Number(value), 0),
  };
}

/** Shaped like the driver's error for a failed query: the reason is in the monitoring response. */
export function failedQueryError(errorCode: string, errorMessage: string, sqlText: string) {
  return Object.assign(new Error(errorMessage), {
    name: "OperationFailedError",
    code: -1,
    data: { data: { queries: [{ errorCode, errorMessage, sqlText }] } },
  });
}
