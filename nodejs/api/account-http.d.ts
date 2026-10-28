import snowflake from 'snowflake-sdk';

/** Compatible injected driver. No module-global configure calls are made. */
interface DriverModule {
    createConnection(options: snowflake.ConnectionOptions): snowflake.Connection;
}
/** Default materialization limits apply during row consumption, not afterward. */
interface ResultOptions {
    format?: "json" | "native";
    rowMode?: "object" | "array";
    maxRows?: number;
    maxBytes?: number;
    /**
     * JSON-format NUMBER and FLOAT values. With "number", NUMBER values become JavaScript numbers
     * only when exact and FLOAT values when finite; anything else fails instead of losing
     * precision. Native format ignores this setting. Default: "string".
     */
    numbers?: "string" | "number";
}
/** Structural interface implemented by Web Headers and Next.js request headers. */
interface HeaderReader {
    get(name: string): string | null | undefined;
}
/** Exactly one source is required. A supplied empty token is invalid. */
type CallerContext = {
    headers: HeaderReader;
    token?: never;
} | {
    token: string;
    headers?: never;
};
/** Username and password are resolved together from a single source. */
interface PasswordSecret {
    username: string;
    password: string;
}
/** Secret source may return undefined only when absent, not when revoked. */
interface SecretProvider {
    readonly id: string;
    resolve(name: string, type: "string" | "password" | "accessToken"): Promise<string | PasswordSecret | undefined>;
}
/**
 * Events never contain SQL, binds, rows, credentials, profile values, file paths, or error
 * messages.
 */
interface LogEvent {
    event: string;
    queryId?: string;
    /** The SDK error code. */
    code?: string;
    /** Whole milliseconds, including session acquisition. */
    durationMs?: number;
    /** Returned rows, as in QueryResult. */
    rowCount?: number;
    /** Snowflake's numeric error code. */
    errorCode?: string;
    mode?: "owner" | "caller";
}
/** Reuse requires application-specific restoration of all SQL session state. */
type PoolOptions = {
    maxConnections?: number;
    maxQueue?: number;
    acquireTimeoutMs?: number;
    handleIdleTimeoutMs?: number;
} & ({
    mode?: "isolated";
    reset?: never;
    idleTimeoutMs?: never;
    maxLifetimeMs?: never;
    resetTimeoutMs?: never;
} | {
    mode: "reusable";
    reset: (connection: snowflake.Connection) => Promise<void>;
    idleTimeoutMs?: number;
    maxLifetimeMs?: number;
    resetTimeoutMs?: number;
});
type FetchClientOptions = Pick<SarClientOptions, "timeouts">;
/** Standard fetch options plus a per-request deadline. */
type FetchInit = RequestInit & {
    /** Deadline for this request, including reading its body. Overrides `timeouts.httpMs`. */
    timeoutMs?: number;
};
interface FetchScope {
    fetch(path: string, init?: FetchInit): Promise<Response>;
}
interface FetchClient extends FetchScope {
    asCaller(context: CallerContext): FetchScope;
    close(): Promise<void>;
}
/** Options are checked at runtime for JavaScript callers as well. */
type SarClientOptions = {
    /**
     * Borrowed native-options provider from createConnectionOptions; configure it with explicit
     * connection options. Without it, work that needs a Snowflake connection fails.
     */
    connectionOptions?: ConnectionOptionsProvider;
    pool?: PoolOptions;
    timeouts?: {
        waitMs?: number;
        consumeMs?: number;
        closeMs?: number;
        /** Default fetch() deadline, including reading the response body. Default: 120 seconds. */
        httpMs?: number;
    };
    results?: ResultOptions;
    secrets?: {
        directory?: string;
        envPrefix?: string;
        providers?: readonly SecretProvider[];
    };
    driver?: DriverModule;
    logger?: (event: LogEvent) => void;
};

type NativeConnectionOptions = snowflake.ConnectionOptions;
/** Trusted application dependency. Returned native options contain credentials. */
interface ConnectionOptionsProvider {
    getOwnerOptions(): NativeConnectionOptions;
    /** The caller's token, taken from the sf-context-current-user-token header. */
    getCallerOptions(token: string): NativeConnectionOptions;
}

declare function createFetchClient(provider?: ConnectionOptionsProvider, input?: FetchClientOptions): FetchClient;

export { createFetchClient };
export type { FetchClient, FetchClientOptions, FetchInit, FetchScope };
