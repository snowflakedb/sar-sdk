/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type snowflake from "snowflake-sdk";
import type { DriverModule } from "../src/types.js";

type CreatePool = DriverModule["createPool"];
type Pool = ReturnType<CreatePool>;
type Factory = {
  create(): Promise<snowflake.Connection>;
  destroy(connection: snowflake.Connection): Promise<void>;
  validate(connection: snowflake.Connection): Promise<boolean>;
};

const load = createRequire(path.join(process.cwd(), "package.json"));
// The generic-pool the pinned driver depends on, so the pools behave like the driver's own.
const genericPool = createRequire(load.resolve("snowflake-sdk"))("generic-pool") as {
  createPool(factory: Factory, options?: Parameters<CreatePool>[1]): Pool;
};

/** A fake driver: createPool builds its connections with createConnection. */
export type FakeDriverModule = DriverModule & {
  createConnection(options: snowflake.ConnectionOptions): snowflake.Connection;
};

/** snowflake-sdk 3.4.0's createPool, building connections with the driver's createConnection. */
export function driverPool(driver: Pick<FakeDriverModule, "createConnection">): CreatePool {
  return (options, poolOptions) => {
    const pool = genericPool.createPool(
      {
        create() {
          const connection = driver.createConnection(options);
          return new Promise((resolve, reject) => {
            connection.connect((error) =>
              error ? reject(new Error(error.message)) : resolve(connection),
            );
          });
        },
        destroy(connection) {
          return new Promise((resolve) => {
            connection.destroy(() => resolve());
          });
        },
        validate: (connection) => connection.isValidAsync(),
      },
      poolOptions,
    );
    // The driver fails every waiting request with the login error.
    pool.on("factoryCreateError", (error: unknown) => {
      const waiting = (
        pool as unknown as {
          _waitingClientsQueue: { dequeue(): { reject(error: unknown): void } | undefined };
        }
      )._waitingClientsQueue;
      for (let request = waiting.dequeue(); request; request = waiting.dequeue())
        request.reject(error);
    });
    return pool;
  };
}
