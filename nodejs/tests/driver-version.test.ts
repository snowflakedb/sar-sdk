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

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const pinned = manifest.dependencies["snowflake-sdk"];

describe("snowflake-sdk version", () => {
  it("is pinned to one exact version", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the version installed from the lockfile", () => {
    const installed = JSON.parse(
      readFileSync(path.join(root, "node_modules", "snowflake-sdk", "package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(pinned);
  });

  it("is the tested driver version the README names", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const named = [...readme.matchAll(/tested (?:driver is exactly|baseline is) (\d+\.\d+\.\d+)/g)];
    expect(named.length).toBeGreaterThan(0);
    expect(named.map((match) => match[1])).toEqual(named.map(() => pinned));
  });
});
