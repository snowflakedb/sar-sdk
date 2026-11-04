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

import { fail, keys } from "../src/core/errors.js";
import type { ConnectionOptionsProvider } from "../src/connection-options/connection-options.js";
import { createConnectionManager } from "../src/connection-manager/index.js";
import { createFetchClient } from "../src/fetch-client/index.js";
import { createQueryClient } from "../src/query-client/index.js";
import { createSarClient, type SarClient } from "../src/sar-client.js";
import { createSecretsClient } from "../src/secrets-client/index.js";
import type { SarClientOptions } from "./sar-client-options.js";

/** Keeps tests offline: without connectionOptions, the helper never falls back to fromDefault(). */
export const unconfigured: ConnectionOptionsProvider = Object.freeze({
  getOwnerOptions: () => fail("AUTH_NOT_FOUND", "No test connection options"),
  getCallerOptions: () => fail("AUTH_NOT_FOUND", "No test connection options"),
});

/** Test helper: builds the four components from one options object, as the old aggregate did. */
export function createTestClient(input: SarClientOptions = {}): SarClient {
  keys(
    input,
    ["connectionOptions", "pool", "timeouts", "results", "secrets", "driver", "logger"],
    "client",
  );
  const { pool, timeouts, results, secrets, driver, logger } = input;
  const connectionOptions = input.connectionOptions ?? unconfigured;
  const connections = createConnectionManager(connectionOptions, {
    pool,
    timeouts,
    driver,
    logger,
  });
  return createSarClient({
    queryClient: createQueryClient(connections, { results, timeouts }),
    fetchClient: createFetchClient(connectionOptions, { timeouts }),
    secretsClient: createSecretsClient(secrets),
  });
}
