import snowflake from 'snowflake-sdk';

/** Structural interface implemented by Web Headers and Next.js request headers. */
interface HeaderReader {
    get(name: string): string | null | undefined;
}
/** Extracts caller context; it does not validate the token or authenticate ingress. */
declare function getCallerUserToken(headers: HeaderReader): string | null;

/** Read one SnowCLI connection from its TOML configuration, without environment overlays. */
declare function fromToml(input?: {
    name?: string;
    configFile?: string;
}): snowflake.ConnectionOptions;
/**
 * The OAuth session token a Snowflake-hosted service mounts at /snowflake/session/token, with the
 * account and endpoint it sets in SNOWFLAKE_* variables. The same on SPCS and Serverless. Returned
 * options hold the owner's token, so caller options append the caller's token to it.
 */
declare function fromPlatform(): snowflake.ConnectionOptions;
/**
 * The platform's session token when the service has mounted one, otherwise the default SnowCLI
 * profile, so an app needs no NODE_ENV check to run both deployed and locally. It takes no
 * options: to choose a profile or a source yourself, call fromToml() or fromPlatform() directly.
 */
declare function fromDefault(): snowflake.ConnectionOptions;

type NativeConnectionOptions = snowflake.ConnectionOptions;
/** Trusted application dependency. Returned native options contain credentials. */
interface ConnectionOptionsProvider {
    getOwnerOptions(): NativeConnectionOptions;
    /** The caller's token, taken from the sf-context-current-user-token header. */
    getCallerOptions(token: string): NativeConnectionOptions;
}
interface ConnectionOptionsFactoryOptions {
    /**
     * Run caller views and getCallerOptions() as the owner, even when caller context is present.
     * The SDK doesn't detect when: pass the app's own condition, such as
     * `process.env.NODE_ENV === "development"`. Default: false.
     */
    callerAsOwner?: boolean;
}
/**
 * Native options from explicit connection options. Nothing is read until an option getter runs, so
 * a `token` getter on the connection options (see fromPlatform) can rotate. Caller options append
 * the caller's token to the `token` of an OAUTH or PROGRAMMATIC_ACCESS_TOKEN connection, the only
 * authenticators whose login sends it, and throw AUTH_NOT_SUPPORTED for any other.
 */
declare function createConnectionOptions(connection: NativeConnectionOptions, input?: ConnectionOptionsFactoryOptions): ConnectionOptionsProvider;

export { createConnectionOptions, fromDefault, fromPlatform, fromToml, getCallerUserToken };
export type { ConnectionOptionsFactoryOptions, ConnectionOptionsProvider, NativeConnectionOptions };
