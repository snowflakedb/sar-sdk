import snowflake from 'snowflake-sdk';

/** Compatible injected driver. No module-global configure calls are made. */
interface DriverModule {
    createConnection(options: snowflake.ConnectionOptions): snowflake.Connection;
}
/** Trusted deployment classification, never supplied from request headers. */
type Environment = "auto" | "local" | "preview" | "deployed";
/** Platform-specific caller authentication protocol. */
type Platform = "auto" | "spcs" | "serverless";
/** Account/profile selection and default SQL context. */
interface ConnectionOptions {
    name?: string;
    configFile?: string;
    account?: string;
    host?: string;
    accessUrl?: string;
    username?: string;
    warehouse?: string;
    database?: string;
    schema?: string;
    role?: string;
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
    environment?: string;
    keys?: string[];
    /** Whole milliseconds, including session acquisition. */
    durationMs?: number;
    /** Returned rows, as in QueryResult. */
    rowCount?: number;
    /** Snowflake's numeric error code. */
    errorCode?: string;
    mode?: "owner" | "caller";
}
/** Configuration sources are unprobed until an actual operation selects one. */
interface ClientDiagnostics {
    environment: Exclude<Environment, "auto"> | "unknown";
    platform: Exclude<Platform, "auto"> | "unknown";
    evidence: string[];
    connectionName?: string;
    endpoint?: string;
    /** Sorted names, never values, of selected-profile keys the SDK doesn't use. */
    ignoredProfileKeys?: string[];
    providers: {
        id: string;
        state: "unprobed" | "selected";
    }[];
    sessionMode: "isolated" | "reusable";
    activeConnections: number;
    queuedOperations: number;
    idleConnections: number;
    physicalConnections: number;
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
type CloseOptions = {
    timeoutMs?: number;
};
/** A scoped native-driver interface, with no identity switch or parent shutdown. */
interface ConnectionScope {
    withConnection<T>(callback: (connection: snowflake.Connection) => Promise<T>): Promise<T>;
}
interface ConnectionManager extends ConnectionScope {
    asCaller(context: CallerContext): ConnectionScope;
    connect(): Promise<void>;
    diagnostics(): Promise<ClientDiagnostics>;
    close(options?: CloseOptions): Promise<void>;
}
type ConnectionManagerOptions = Pick<SarClientOptions, "pool" | "timeouts" | "driver">;
/**
 * Options are checked at runtime for JavaScript callers as well. Without connectionOptions, the
 * client creates and closes an options factory from the connection settings and timeouts.authMs.
 */
type SarClientOptions = {
    pool?: PoolOptions;
    timeouts?: {
        authMs?: number;
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
} & ({
    connectionOptions?: undefined;
    connection?: ConnectionOptions;
    environment?: Environment;
    platform?: Platform;
    /** Interactive login needs local execution; "always" permits it without a terminal. */
    interactive?: "auto" | "always" | "never";
    /**
     * When caller context is missing, use owner credentials in local or preview execution
     * ("auto") or never ("error").
     */
    callerFallback?: "auto" | "error";
    /**
     * Run caller views as the owner, even when caller context is present. The SDK doesn't
     * detect when: pass the app's own condition, such as
     * `process.env.NODE_ENV === "development"`. Default: false.
     */
    callerAsOwner?: boolean;
    driverOptions?: DriverOptions;
    logger?: (event: LogEvent) => void;
} | {
    /** Borrowed native-options provider; configure it and close it after its consumers. */
    connectionOptions: ConnectionOptionsProvider;
    connection?: never;
    environment?: never;
    platform?: never;
    interactive?: never;
    callerFallback?: never;
    callerAsOwner?: never;
    driverOptions?: never;
    logger?: never;
});
/** Safe driver tuning; authentication and owned-session flags are not overrides. */
type DriverOptions = Pick<snowflake.ConnectionOptions, "clientStoreTemporaryCredential" | "credentialCacheDir" | "clientRequestMFAToken" | "browserActionTimeout" | "openExternalBrowserCallback" | "proxyHost" | "proxyPort" | "proxyProtocol" | "proxyUser" | "proxyPassword" | "noProxy">;

interface Detected {
    environment: "local" | "preview" | "deployed" | "unknown";
    platform: "serverless" | "spcs" | "unknown";
    evidence: string[];
}

type NativeConnectionOptions = snowflake.ConnectionOptions;
interface AcquireOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
interface ConnectionOptionsDiagnostics extends Detected {
    connectionName?: string;
    endpoint?: string;
    /** Sorted names, never values, of selected-profile keys the SDK doesn't use. */
    ignoredProfileKeys?: string[];
    providers: {
        id: string;
        state: "unprobed" | "selected";
    }[];
}
/** Trusted application dependency. Returned native options contain credentials. */
interface ConnectionOptionsProvider {
    getOwnerOptions(options?: AcquireOptions): Promise<NativeConnectionOptions>;
    getCallerOptions(context: CallerContext, options?: AcquireOptions): Promise<NativeConnectionOptions>;
    /** Must be redacted and must not authenticate or acquire credentials. */
    diagnostics?(): Promise<ConnectionOptionsDiagnostics>;
}

/** Lazy native-driver access. Components using this manager borrow it, never own it. */
declare function createConnectionManager(provider?: ConnectionOptionsProvider, input?: ConnectionManagerOptions): ConnectionManager;

export { createConnectionManager };
export type { ConnectionManager, ConnectionManagerOptions, ConnectionScope, PoolOptions };
