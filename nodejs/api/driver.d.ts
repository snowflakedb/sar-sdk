import snowflake from 'snowflake-sdk';
export { Connection, ConnectionOptions } from 'snowflake-sdk';

/**
 * Compatible injected driver. Every session comes from its connection pools. No module-global
 * configure calls are made.
 */
interface DriverModule {
    createPool(options: snowflake.ConnectionOptions, poolOptions?: NonNullable<Parameters<typeof snowflake.createPool>[1]>): ReturnType<typeof snowflake.createPool>;
}

export type { DriverModule };
