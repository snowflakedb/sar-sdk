import snowflake from 'snowflake-sdk';
export { Connection, ConnectionOptions } from 'snowflake-sdk';

/** Compatible injected driver. No module-global configure calls are made. */
interface DriverModule {
    createConnection(options: snowflake.ConnectionOptions): snowflake.Connection;
}

export type { DriverModule };
