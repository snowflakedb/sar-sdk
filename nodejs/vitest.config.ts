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
    include: ["tests/**/*.test.ts"],
    testTimeout: 5000,
    hookTimeout: 5000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/browser.ts", "src/types.ts", "src/driver.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // Measured baseline, rounded down to avoid tiny cross-platform V8 differences.
      thresholds: { statements: 86, branches: 79, functions: 86, lines: 87 },
    },
  },
});
