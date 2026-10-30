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
interface SecretsOptions {
    directory?: string;
    envPrefix?: string;
    providers?: readonly SecretProvider[];
}
interface SecretsClient extends Secrets {
    close(): Promise<void>;
}
/** Standalone secrets own their HTTP transport and never resolve SQL credentials. */
declare function createSecrets(options?: SecretsOptions): SecretsClient;

export { createSecrets };
export type { PasswordSecret, SecretProvider, SecretsClient, SecretsOptions };
