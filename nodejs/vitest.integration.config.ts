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

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration tests only, run by npm run test:integration. They need a real account, so they are
// not part of npm test, npm run test:coverage, or npm run check, and they measure no coverage.
// Timeouts allow for login, warehouse resume, and a slow network, not for a performance claim.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@snowflake\/sar-sdk$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One account, one set of sessions: keep the SQL order predictable.
    fileParallelism: false,
  },
});
