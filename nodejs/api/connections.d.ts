import snowflake from 'snowflake-sdk';

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

type NativeConnectionOptions = snowflake.ConnectionOptions;
/** Trusted application dependency. Returned native options contain credentials. */
interface ConnectionOptionsProvider {
    getOwnerOptions(): NativeConnectionOptions;
    /** The caller's token, taken from the sf-context-current-user-token header. */
    getCallerOptions(token: string): NativeConnectionOptions;
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
type CloseOptions = {
    timeoutMs?: number;
};

/** Client deadlines; each component reads only the ones that apply to it. */
interface TimeoutOptions {
    waitMs?: number;
    consumeMs?: number;
    closeMs?: number;
    /** Default fetch() deadline, including reading the response body. Default: 120 seconds. */
    httpMs?: number;
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

/** A scoped native-driver interface, with no identity switch or parent shutdown. */
interface ConnectionScope {
    withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>): Promise<T>;
}

interface ClientDiagnostics {
    sessionMode: "isolated" | "reusable";
    activeConnections: number;
    queuedOperations: number;
    idleConnections: number;
    physicalConnections: number;
}
interface ConnectionManager extends ConnectionScope {
    asCaller(context: CallerContext): ConnectionScope;
    connect(): Promise<void>;
    diagnostics(): Promise<ClientDiagnostics>;
    close(options?: CloseOptions): Promise<void>;
}
type ConnectionManagerOptions = {
    pool?: PoolOptions;
    timeouts?: TimeoutOptions;
    driver?: DriverModule;
    logger?: (event: LogEvent) => void;
};
/** Lazy native-driver access. Components using this manager borrow it, never own it. */
declare function createConnectionManager(provider?: ConnectionOptionsProvider, input?: ConnectionManagerOptions): ConnectionManager;

export { createConnectionManager };
export type { ConnectionManager, ConnectionManagerOptions, ConnectionScope, DriverPoolOptions, PoolOptions };
