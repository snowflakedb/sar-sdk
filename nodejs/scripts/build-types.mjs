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

import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import dts from "rollup-plugin-dts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const entries = {
  index: "index",
  auth: "connection-options/index",
  connections: "connection-manager/index",
  queries: "query-client/index",
  "account-http": "fetch-client/index",
  "secret-client": "secrets-client/index",
  driver: "driver",
  browser: "browser",
};

// Bundle each public entry so declaration files do not point at private modules,
// then mirror them to .d.cts for the CommonJS exports condition.
for (const [name, source] of Object.entries(entries)) {
  const bundle = await rollup({
    input: path.join(packageRoot, "src", `${source}.ts`),
    onwarn(warning, warn) {
      // browser.ts only throws; it has no exported types.
      if (warning.code === "EMPTY_BUNDLE") return;
      warn(warning);
    },
    plugins: [
      dts({
        tsconfig: path.join(packageRoot, "tsconfig.build.json"),
      }),
    ],
  });
  const file = path.join(packageRoot, "dist", `${name}.d.ts`);
  await bundle.write({ file, format: "es" });
  await bundle.close();
  await copyFile(file, path.join(packageRoot, "dist", `${name}.d.cts`));
}
