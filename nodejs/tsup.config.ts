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

import { defineConfig } from "tsup";

const entry = [
  "src/index.ts",
  "src/auth.ts",
  "src/connections.ts",
  "src/queries.ts",
  "src/account-http.ts",
  "src/secret-client.ts",
  "src/driver.ts",
  "src/browser.ts",
];
const shared = {
  entry,
  splitting: true,
  // tsup 8 bundles rollup-plugin-dts 6.1.1, which reads the TypeScript compiler
  // API. TypeScript 7 does not expose that API, so declaration emit lives in
  // scripts/build-types.mjs.
  dts: false,
  target: "node22",
  external: ["snowflake-sdk", "smol-toml", "undici"],
};
// tsup's CJS splitting pass emits maps of generated chunks with absolute paths.
// Ship original-source maps for ESM; CJS still ships readable code and TS sources.
export default defineConfig([
  { ...shared, format: ["esm"], sourcemap: true },
  { ...shared, format: ["cjs"], sourcemap: false },
]);
