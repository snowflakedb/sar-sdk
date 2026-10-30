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

/** Standard fetch options plus a per-request deadline. */
type FetchInit = RequestInit & {
    /** Deadline for this request, including reading its body. Overrides `timeouts.httpMs`. */
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

type FetchClientOptions = {
    timeouts?: TimeoutOptions;
};
interface FetchScope {
    /**
     * Authenticated fetch to an account-relative path, retaining this view's identity.
     * Redirects are rejected; consume or cancel the returned response body.
     * Throws AUTH_NOT_SUPPORTED_FOR_REST when the credential cannot authorize HTTP.
     */
    fetch(path: string, init?: FetchInit): Promise<Response>;
}
interface FetchClient extends FetchScope {
    asCaller(context: CallerContext): FetchScope;
    close(): Promise<void>;
}
declare function createFetchClient(provider?: ConnectionOptionsProvider, input?: FetchClientOptions): FetchClient;

export { createFetchClient };
export type { FetchClient, FetchClientOptions, FetchInit, FetchScope };
