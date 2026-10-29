import snowflake from 'snowflake-sdk';

type NativeConnectionOptions = snowflake.ConnectionOptions;
/** Trusted application dependency. Returned native options contain credentials. */
interface ConnectionOptionsProvider {
    getOwnerOptions(): NativeConnectionOptions;
    /** The caller's token, taken from the sf-context-current-user-token header. */
    getCallerOptions(token: string): NativeConnectionOptions;
}

/**
 * Compatible injected driver. Every session comes from its connection pools. No module-global
 * configure calls are made.
 */
interface DriverModule {
    createPool(options: snowflake.ConnectionOptions, poolOptions?: NonNullable<Parameters<typeof snowflake.createPool>[1]>): ReturnType<typeof snowflake.createPool>;
}
/** Pool settings the SDK derives from its own options. */
type SdkPoolKeys = "max" | "min" | "acquireTimeoutMillis" | "maxWaitingClients" | "idleTimeoutMillis";
/**
 * The driver's pool options, such as `fifo`, `testOnBorrow`, or `evictionRunIntervalMillis`,
 * passed to `createPool` unchanged. The SDK sets the size, wait, and idle-timeout settings.
 */
type DriverPoolOptions = Omit<NonNullable<Parameters<typeof snowflake.createPool>[1]>, SdkPoolKeys>;
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
/** No SQL authentication is performed by these methods. */
interface Secrets {
    getString(name: string): Promise<string>;
    getPassword(name: string): Promise<PasswordSecret>;
    getAccessToken(name: string): Promise<string>;
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
    driverPoolOptions?: DriverPoolOptions;
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
type SecretsOptions = NonNullable<SarClientOptions["secrets"]>;
interface SecretsClient extends Secrets {
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

/** Standalone secrets own their HTTP transport and never resolve SQL credentials. */
declare function createSecrets(options?: SecretsOptions): SecretsClient;

export { createSecrets };
export type { PasswordSecret, SecretProvider, SecretsClient, SecretsOptions };
