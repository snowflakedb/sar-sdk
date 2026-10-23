import snowflake from 'snowflake-sdk';

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
interface ConnectionOptionsFactory extends ConnectionOptionsProvider {
    diagnostics(): Promise<ConnectionOptionsDiagnostics>;
    /** Abort factory waits, not connections created from prior snapshots. */
    close(): Promise<void>;
}
interface ConnectionOptionsFactoryOptions {
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
     * Run caller views and getCallerOptions() as the owner, even when caller context is present.
     * The SDK doesn't detect when: pass the app's own condition, such as
     * `process.env.NODE_ENV === "development"`. Default: false.
     */
    callerAsOwner?: boolean;
    authTimeoutMs?: number;
    driverOptions?: DriverOptions;
    logger?: (event: LogEvent) => void;
}
/** Lazy source selection; each async getter acquires fresh credentials without SQL login. */
declare function createConnectionOptions(source?: AuthProvider | readonly AuthProvider[], input?: ConnectionOptionsFactoryOptions): ConnectionOptionsFactory;

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
/** Safe driver tuning; authentication and owned-session flags are not overrides. */
type DriverOptions = Pick<snowflake.ConnectionOptions, "clientStoreTemporaryCredential" | "credentialCacheDir" | "clientRequestMFAToken" | "browserActionTimeout" | "openExternalBrowserCallback" | "proxyHost" | "proxyPort" | "proxyProtocol" | "proxyUser" | "proxyPassword" | "noProxy">;

interface Detected {
    environment: "local" | "preview" | "deployed" | "unknown";
    platform: "serverless" | "spcs" | "unknown";
    evidence: string[];
}

/** Stable identifiers used when transforming the default provider list. */
declare const authProviderIds: Readonly<{
    platform: "platform";
    environment: "environment";
    profile: "profile";
}>;
/** Driver-managed login recipes supported by this adapter, not arbitrary driver configuration. */
type DriverCredentialOptions = Pick<snowflake.ConnectionOptions, "account" | "accessUrl" | "host" | "username" | "warehouse" | "database" | "schema" | "role" | "authenticator" | "password" | "token" | "privateKey" | "privateKeyPath" | "privateKeyPass" | "oauthClientId" | "oauthClientSecret" | "oauthAuthorizationUrl" | "oauthTokenRequestUrl" | "oauthScope" | "oauthRedirectUri" | "clientStoreTemporaryCredential" | "clientRequestMFAToken" | "credentialCacheDir">;
/** OAuth and PAT credentials are intentionally not interchangeable. */
type Credential = {
    type: "oauth" | "pat";
    token: string;
} | {
    type: "password";
    username: string;
    password: string;
} | {
    type: "keypair";
    username: string;
    privateKey?: string;
    privateKeyPath?: string;
    privateKeyPass?: string;
} | {
    type: "driver";
    options: DriverCredentialOptions;
};
/** Resolution and acquisition are separate; diagnostics never call either hook. */
interface CredentialSource {
    readonly target: ConnectionOptions;
    readonly platform?: "spcs" | "serverless";
    acquire(): Promise<Credential>;
}
/** Context is trusted application configuration, never a request-supplied target. */
interface AuthContext {
    readonly connection: Readonly<ConnectionOptions>;
}
/** Return undefined only for an optional absent source. Other failures are fatal. */
interface AuthProvider {
    readonly id: string;
    /** Optional configured profile name for non-probing diagnostics. */
    readonly connectionName?: string;
    resolve(context: AuthContext): Promise<CredentialSource | undefined>;
}
/** Extracts caller context; it does not validate the token or authenticate ingress. */
declare function getCallerUserToken(headers: HeaderReader): string | null;
/** Read a trusted token file for every acquisition. Explicit paths are required by default. */
declare function fromTokenFile(options: {
    id: string;
    path: string;
    type: "oauth" | "pat";
    optional?: boolean;
    target?: ConnectionOptions;
    platform?: "spcs" | "serverless";
}): AuthProvider;
/** Explicit credentials for a trusted target. Prefer rotating providers for long-lived tokens. */
declare function fromCredentials(options: {
    id?: string;
    target: ConnectionOptions;
    credential: Credential;
}): AuthProvider;
/** A SnowCLI-compatible profile source. Selection does not imply local execution. */
declare function fromToml(input?: {
    name?: string;
    configFile?: string;
    environmentOverrides?: boolean;
}): AuthProvider;
/** A complete environment identity; returns undefined only when absent/incomplete. */
declare function fromEnvironment(): AuthProvider;
/** Verified application mounts only; never host-agent credentials. */
declare function fromPlatform(input?: {
    environment?: Environment;
    platform?: Platform;
}): AuthProvider;

export { authProviderIds, createConnectionOptions, fromCredentials, fromEnvironment, fromPlatform, fromTokenFile, fromToml, getCallerUserToken };
export type { AcquireOptions, AuthContext, AuthProvider, ConnectionOptionsDiagnostics, ConnectionOptionsFactory, ConnectionOptionsFactoryOptions, ConnectionOptionsProvider, Credential, CredentialSource, DriverCredentialOptions, NativeConnectionOptions };
