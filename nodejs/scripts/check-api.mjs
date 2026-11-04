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

// Compares the built declaration files with the API snapshot in api/, so public API changes show
// up in review. Run it after a build. Pass --update to rewrite the snapshot.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const snapshot = path.join(root, "api");

async function declarations(directory) {
  const names = await readdir(directory).catch(() => []);
  return names.filter((name) => name.endsWith(".d.ts")).sort();
}

async function read(directory, name) {
  return (await readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n");
}

const built = await declarations(dist);
if (built.length === 0) throw new Error("No declarations in dist; build first");

if (process.argv.includes("--update")) {
  await rm(snapshot, { recursive: true, force: true });
  await mkdir(snapshot, { recursive: true });
  for (const name of built) await writeFile(path.join(snapshot, name), await read(dist, name));
  console.log(`Updated the API snapshot (${built.length} files)`);
} else {
  const recorded = await declarations(snapshot);
  const changed = [];
  for (const name of new Set([...built, ...recorded])) {
    const current = built.includes(name) ? await read(dist, name) : undefined;
    const expected = recorded.includes(name) ? await read(snapshot, name) : undefined;
    if (current !== expected) changed.push(name);
  }
  if (changed.length > 0) {
    console.error(`The public API changed: ${changed.join(", ")}`);
    console.error(
      "Run npm run api:update, review the diff in api/, and call out the change " +
        "for compatibility review.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Public API matches the snapshot (${built.length} files)`);
  }
}
