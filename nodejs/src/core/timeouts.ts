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

import { duration, fail, keys } from "./errors.js";

/** Client deadlines; each component reads only the ones that apply to it. */
export interface TimeoutOptions {
  waitMs?: number;
  consumeMs?: number;
  closeMs?: number;
  /** Default fetch() deadline, including reading the response body. Default: 120 seconds. */
  httpMs?: number;
}

/** Validates timeouts and returns a copy, so later changes to the caller's object don't apply. */
export function timeoutOptions(input: TimeoutOptions | undefined): TimeoutOptions {
  keys(input === undefined ? {} : input, ["waitMs", "consumeMs", "closeMs", "httpMs"], "timeouts");
  for (const [key, value] of Object.entries(input ?? {})) duration(value, key);
  if (input?.httpMs !== undefined && !Number.isInteger(input.httpMs))
    fail("INVALID_OPTIONS", "httpMs must be an integer");
  return { ...input };
}
