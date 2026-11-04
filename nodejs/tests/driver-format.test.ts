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
import { describe, expect, it } from "vitest";
import { executionOptions } from "../src/query-client/results.js";

const load = createRequire(path.join(process.cwd(), "package.json"));
const driverEntry = load.resolve("snowflake-sdk");
const SfTimestamp = load(
  path.join(path.dirname(driverEntry), "lib/connection/result/sf_timestamp.js"),
);

describe("pinned driver formatting contract", () => {
  it("preserves nine digits without leaking SQL literal quotes", () => {
    const parameters = executionOptions({}).parameters as Record<string, string>;
    const timestamp = new SfTimestamp(
      1790166896,
      123456789,
      9,
      "UTC",
      parameters.TIMESTAMP_NTZ_OUTPUT_FORMAT,
    );
    expect(timestamp.toString()).toBe("2026-09-23T12:34:56.123456789");
    for (const type of ["LTZ", "TZ"]) {
      const zoned = new SfTimestamp(
        1790166896,
        123456789,
        9,
        "UTC",
        parameters[`TIMESTAMP_${type}_OUTPUT_FORMAT`],
      );
      expect(zoned.toString()).toBe("2026-09-23T12:34:56.123456789+00:00");
    }
  });
});
