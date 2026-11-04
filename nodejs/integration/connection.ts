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

import type { NativeConnectionOptions } from "../src/connection-options/index.js";

/**
 * Connection options for the integration tests, read from the environment. Only these tests read
 * credentials from the environment: the SDK takes explicit connection options, and the offline
 * tests in `tests/` use synthetic ones. Values are never logged, and a failure names only the
 * variables that are missing.
 */

/** Key-pair authentication. A password is deliberately not supported. */
const required = ["SNOWFLAKE_TEST_ACCOUNT", "SNOWFLAKE_TEST_USER", "SNOWFLAKE_TEST_PRIVATE_KEY"];

/** An unset variable and one set to whitespace are both absent; CI passes "" for an unset secret. */
function value(name: string): string | undefined {
  const text = process.env[name];
  return text === undefined || text.trim() === "" ? undefined : text;
}

/**
 * Throws naming every missing variable, so a run fails instead of silently falling back to a
 * developer's own profile or to a default account.
 */
export function integrationConnection(): NativeConnectionOptions {
  const missing = required.filter((name) => value(name) === undefined);
  if (missing.length > 0)
    throw new Error(
      `The integration tests need ${missing.join(", ")} in the environment. ` +
        "See nodejs/CONTRIBUTING.md for the full list and how to set them.",
    );
  // Omitted rather than set to undefined, so the driver sees only what the environment supplies.
  const privateKeyPass = value("SNOWFLAKE_TEST_PRIVATE_KEY_PASSWORD");
  const host = value("SNOWFLAKE_TEST_HOST");
  const role = value("SNOWFLAKE_TEST_ROLE");
  const warehouse = value("SNOWFLAKE_TEST_WAREHOUSE");
  const database = value("SNOWFLAKE_TEST_DATABASE");
  const schema = value("SNOWFLAKE_TEST_SCHEMA");
  return {
    account: value("SNOWFLAKE_TEST_ACCOUNT"),
    username: value("SNOWFLAKE_TEST_USER"),
    authenticator: "SNOWFLAKE_JWT",
    privateKey: value("SNOWFLAKE_TEST_PRIVATE_KEY"),
    ...(privateKeyPass !== undefined && { privateKeyPass }),
    ...(host !== undefined && { host }),
    ...(role !== undefined && { role }),
    ...(warehouse !== undefined && { warehouse }),
    ...(database !== undefined && { database }),
    ...(schema !== undefined && { schema }),
  };
}
