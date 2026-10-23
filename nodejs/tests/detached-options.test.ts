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

import { describe, expect, it } from "vitest";
import {
  detachedOptions,
  lookupOptions,
  pollOptions,
  queryReference,
} from "../src/detached-options.js";
import type { QueryReference } from "../src/types.js";

function reference(): QueryReference {
  return {
    version: 1,
    queryId: "01000000-0000-0000-0000-00000000abcd",
    submittedAt: "2026-09-29T00:00:00.000Z",
    identity: { organization: "ORG", account: "ACCOUNT", user: "USER", role: "ROLE" },
    mode: "owner",
    results: { format: "json", rowMode: "object", maxRows: 100_000, maxBytes: 32 * 1024 * 1024 },
  };
}

describe("detached query contracts", () => {
  it("snapshots and freezes serializable query metadata", () => {
    const input = JSON.parse(JSON.stringify(reference()));
    const snapshot = queryReference(input);
    input.identity.user = "OTHER";
    input.results.maxRows = 1;
    expect(snapshot).toEqual(reference());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
    expect(Object.isFrozen(snapshot.results)).toBe(true);
  });
  it.each([
    null,
    [],
    { version: 2 },
    { queryId: "not-a-query" },
    { queryId: undefined },
    { submittedAt: "yesterday" },
    { submittedAt: "2026-09-29" },
    { submittedAt: null },
    { mode: "admin" },
    { identity: null },
    { identity: { ...reference().identity, role: " " } },
    { identity: { ...reference().identity, token: "synthetic" } },
    { results: {} },
    { results: null },
    { results: { ...reference().results, maxRows: 0 } },
    { results: { ...reference().results, maxBytes: 1.5 } },
    { results: { ...reference().results, format: "text" } },
    { results: { ...reference().results, decodeRow: () => null } },
    { token: "synthetic" },
  ])("rejects invalid reference fields: %j", (override) => {
    const input =
      override === null || Array.isArray(override) ? override : { ...reference(), ...override };
    expect(() => queryReference(input as never)).toThrow();
  });
  it("requires the complete reference", () => {
    expect(() => queryReference({} as never)).toThrow();
  });
  it("separates execution, submission, lookup, and consumption limits", () => {
    expect(detachedOptions(undefined)).toMatchObject({
      submitTimeoutMs: 30_000,
      executionSeconds: 600,
    });
    expect(
      detachedOptions({ maxRows: 5 }, { executionTimeoutMs: 1999, maxRows: undefined }),
    ).toMatchObject({ executionSeconds: 1, settings: { maxRows: 5 } });
    expect(detachedOptions(undefined, { executionTimeoutMs: 604_800_000 }).executionSeconds).toBe(
      604800,
    );
    expect(pollOptions()).toEqual({
      lookupTimeoutMs: 30_000,
      consumeTimeoutMs: undefined,
      decodeRow: undefined,
    });
    expect(pollOptions({ lookupTimeoutMs: undefined, consumeTimeoutMs: 100 })).toMatchObject({
      lookupTimeoutMs: 30_000,
      consumeTimeoutMs: 100,
    });
  });
  it.each([0, -1, 999, 1000.5, 604_800_001, NaN, Infinity, "1000", null])(
    "rejects execution limit %s",
    (executionTimeoutMs) => {
      expect(() => detachedOptions(undefined, { executionTimeoutMs } as never)).toThrow();
    },
  );
  it.each([
    { waitMs: 0 },
    { waitMs: 2_000 },
    { waitMs: undefined },
    { pollIntervalMs: 1_000 },
    { pollIntervalMs: undefined },
  ])("rejects removed server-polling controls %j", (input) => {
    expect(() => pollOptions(input as never)).toThrow(/Unknown query poll option/);
  });
  it.each([
    { submitTimeoutMs: 0 },
    { waitTimeoutMs: 2 },
    { decodeRow: () => null },
    { binds: [], role: "OTHER" },
  ])("rejects invalid submission controls %j", (input) => {
    expect(() => detachedOptions(undefined, input as never)).toThrow();
  });
  it.each([{ lookupTimeoutMs: 0 }, { lookupTimeoutMs: null }, { signal: {} }, { role: "OTHER" }])(
    "rejects invalid lookup controls %j",
    (input) => {
      expect(() => lookupOptions(input as never)).toThrow();
    },
  );
  it.each([
    { lookupTimeoutMs: 0 },
    { consumeTimeoutMs: -1 },
    { consumeTimeoutMs: null },
    { consumeTimeoutMs: NaN },
    { consumeTimeoutMs: Infinity },
    { consumeTimeoutMs: 2_147_483_648 },
    { decodeRow: false },
    { format: "native" },
  ])("rejects invalid poll controls %j", (input) => {
    expect(() => pollOptions(input as never)).toThrow();
  });
});
