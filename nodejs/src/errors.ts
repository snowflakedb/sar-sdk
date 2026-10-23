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

/** Stable failure categories. Driver causes are retained but never serialized. */
export type SarErrorCode =
  | "INVALID_OPTIONS"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "AUTH_NOT_FOUND"
  | "AUTH_FAILED"
  | "AUTH_INTERACTION_REQUIRED"
  | "AUTH_NOT_SUPPORTED"
  | "AUTH_NOT_SUPPORTED_FOR_REST"
  | "CALLER_CONTEXT_REQUIRED"
  | "ENVIRONMENT_CONFLICT"
  | "CLIENT_CLOSED"
  | "QUEUE_FULL"
  | "TIMEOUT"
  | "ABORTED"
  | "QUERY_FAILED"
  | "QUERY_UNAVAILABLE"
  | "QUERY_IDENTITY_MISMATCH"
  | "DETACHED_QUERY_NOT_SUPPORTED"
  | "RESULT_LIMIT_EXCEEDED"
  | "RESULT_CONVERSION_UNSUPPORTED"
  | "DUPLICATE_COLUMNS"
  | "SECRET_NOT_FOUND"
  | "SECRET_UNAVAILABLE"
  | "HTTP_FAILED"
  | "SHUTDOWN_TIMEOUT";

/** Describes what the SDK knows, not a transaction rollback guarantee. */
export type CompletionState = "not-submitted" | "unknown" | "running" | "succeeded" | "failed";

/** Safe operational error with optional non-enumerable underlying cause. */
export class SarError extends Error {
  readonly name = "SarError";
  constructor(
    public readonly code: SarErrorCode,
    message: string,
    public readonly details: {
      queryId?: string;
      completion?: CompletionState;
      /** A short instruction for fixing the failure, when the SDK can suggest one. */
      nextStep?: string;
      /** Snowflake's numeric error code. Its message is only in the non-serialized cause. */
      errorCode?: string;
      /** Five-character SQLSTATE, when Snowflake reported one. */
      sqlState?: string;
    } = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
  /** Redacted representation suitable for structured logging. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, ...this.details };
  }
}

/** Structural guard that works across CommonJS/ESM package instances. */
export function isSarError(value: unknown): value is SarError {
  return (
    value instanceof Error &&
    value.name === "SarError" &&
    "code" in value &&
    typeof value.code === "string"
  );
}

export function fail(code: SarErrorCode, message: string): never {
  throw new SarError(code, message);
}

/** SDK-written `details.nextStep` values. They never include paths, SQL, or credentials. */
export const nextSteps = Object.freeze({
  ingress: "Send requests through Snowflake ingress so they carry caller context.",
  callerFallback:
    "Send requests through Snowflake ingress so they carry caller context, or set callerAsOwner: true in local development to run caller views with owner credentials.",
  interaction:
    'Run from a terminal, use a non-interactive credential, or set interactive: "always" for a local development server started without one.',
  nonInteractive: "Run from a terminal or use a non-interactive credential.",
  discovery:
    "Configure a SnowCLI connection, or select an existing one with SNOWFLAKE_CONNECTION_NAME or connection: { name }.",
  configFile:
    "Point configFile at an existing file, or omit it to use the SnowCLI configuration directory.",
  callerCancel:
    "Grant CALLER OPERATE on the warehouse to the app's owner role so callers can cancel their own queries.",
  callerTransactionOpen:
    "Run the statement in the transaction with tx.query(), or after the transaction ends.",
  callerWorkRunning:
    "Finish the caller's other work, such as streams, submit() handles, and withConnection() callbacks, before starting the transaction.",
});

export function keys(value: object, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_OPTIONS", `${label} options must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("INVALID_OPTIONS", `Unknown ${label} option: ${key}`);
  }
}

export function positive(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    fail("INVALID_OPTIONS", `${label} must be a positive finite number`);
  }
}
export function duration(value: number | undefined, label: string): void {
  positive(value, label);
  if (value !== undefined && value > 2_147_483_647)
    fail("INVALID_OPTIONS", `${label} exceeds the supported timer range`);
}

export function signalOption(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal))
    fail("INVALID_OPTIONS", "signal must be an AbortSignal");
}

/** Undefined optional fields do not erase defaults or disable limits. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Identifiers from a driver error that are safe to serialize; never its message. */
export function snowflakeDetails(
  error: unknown,
): Pick<SarError["details"], "errorCode" | "sqlState"> {
  if (!error || typeof error !== "object" || isSarError(error)) return {};
  const { code, sqlState } = error as { code?: unknown; sqlState?: unknown };
  return defined({
    errorCode:
      (typeof code === "string" || typeof code === "number") && /^\d{3,6}$/.test(String(code))
        ? String(code)
        : undefined,
    sqlState: typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : undefined,
  });
}

/**
 * Details for a cancellation request Snowflake refused. Under restricted caller's rights it
 * refuses a caller's own query with 003001 unless the owner role has CALLER OPERATE.
 */
export function cancellationDetails(
  error: unknown,
  mode: "owner" | "caller",
): Pick<SarError["details"], "errorCode" | "sqlState" | "nextStep"> {
  const details = snowflakeDetails(error);
  return mode === "caller" && details.errorCode === "003001"
    ? { ...details, nextStep: nextSteps.callerCancel }
    : details;
}

export function operationError(
  error: unknown,
  message: string,
  details: SarError["details"] = {},
): SarError {
  return isSarError(error)
    ? new SarError(error.code, error.message, { ...details, ...error.details }, error)
    : new SarError("QUERY_FAILED", message, { ...details, ...snowflakeDetails(error) }, error);
}
