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

import type { ConnectionOptionsProvider } from "../src/connection-options/connection-options.js";
import type { ConnectionManagerOptions } from "../src/connection-manager/connection-manager.js";
import type { DriverModule } from "../src/connection-manager/session-store.js";
import type { ResultOptions } from "../src/query-client/query-options.js";
import type { SecretsOptions } from "../src/secrets-client/secrets-client.js";
import type { TimeoutOptions } from "../src/core/timeouts.js";
import type { LogEvent } from "../src/core/lifecycle.js";

/** The option bag the test helper accepts; each field goes to the component that owns it. */
export type SarClientOptions = {
  connectionOptions?: ConnectionOptionsProvider;
  pool?: ConnectionManagerOptions["pool"];
  timeouts?: TimeoutOptions;
  results?: ResultOptions;
  secrets?: SecretsOptions;
  driver?: DriverModule;
  logger?: (event: LogEvent) => void;
};
