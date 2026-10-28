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

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSarClient } from "../src/index.js";
import { createConnectionOptions } from "../src/auth.js";
import { HttpTransport } from "../src/http.js";
import { fakeDriver } from "./fake-driver.js";

vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(function () {
    throw new Error("Unexpected dispatcher creation");
  }),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected network call");
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe("flat authenticated fetch API", () => {
  it.each(["oauth", "pat"] as const)(
    "passes through the Response using %s without loading SQL",
    async (type) => {
      const response = Response.json({ message: "synthetic" }, { status: 403 });
      const transport = vi.spyOn(HttpTransport.prototype, "fetch").mockResolvedValue(response);
      const fake = fakeDriver();
      const client = createSarClient({
        driver: fake.driver,
        connectionOptions: createConnectionOptions({
          account: "test",
          authenticator: type === "oauth" ? "OAUTH" : "PROGRAMMATIC_ACCESS_TOKEN",
          token: "synthetic-app",
        }),
      });
      try {
        const headers = new Headers({ "x-request-id": "synthetic" });
        const result = await client.fetch("/api/v2/test", {
          method: "POST",
          headers,
          body: "payload",
        });
        expect(result).toBe(response);
        expect(result.status).toBe(403);
        expect(await result.json()).toEqual({ message: "synthetic" });
        expect(transport).toHaveBeenCalledOnce();
        const [url, init] = transport.mock.calls[0]!;
        expect(url).toBe("https://test.snowflakecomputing.com/api/v2/test");
        expect(init).toMatchObject({ method: "POST", body: "payload" });
        const sent = new Headers(init?.headers);
        expect(sent.get("authorization")).toBe("Bearer synthetic-app");
        expect(sent.get("x-snowflake-authorization-token-type")).toBe(
          type === "oauth" ? "OAUTH" : "PROGRAMMATIC_ACCESS_TOKEN",
        );
        expect(sent.get("x-request-id")).toBe("synthetic");
        expect(headers.has("authorization")).toBe(false);
        expect(fake.connections).toHaveLength(0);
        expect(client).not.toHaveProperty("rest");
      } finally {
        await client.close();
      }
    },
  );

  it("keeps overlapping caller and owner fetches isolated", async () => {
    {
      const transport = vi
        .spyOn(HttpTransport.prototype, "fetch")
        .mockImplementation(async () => new Response(null, { status: 204 }));
      const client = createSarClient({
        connectionOptions: createConnectionOptions({
          account: "test",
          authenticator: "OAUTH",
          token: "synthetic-app",
        }),
      });
      const first = client.asCaller({ headers: { get: () => "synthetic-first" } });
      const second = client.asCaller({ token: "synthetic-second" });
      try {
        await Promise.all([first.fetch("/first"), second.fetch("/second"), client.fetch("/owner")]);
        const headersByPath = Object.fromEntries(
          transport.mock.calls.map(([url, init]) => [
            new URL(url).pathname,
            new Headers(init?.headers).get("authorization"),
          ]),
        );
        expect(headersByPath).toEqual({
          "/first": "Bearer synthetic-app.synthetic-first",
          "/second": "Bearer synthetic-app.synthetic-second",
          "/owner": "Bearer synthetic-app",
        });
        expect(first).not.toHaveProperty("rest");
        expect(first).not.toHaveProperty("secrets");
        expect(first).not.toHaveProperty("close");
        const fetch = first.fetch;
        await client.close();
        await expect(fetch("/after-close")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
        await expect(client.fetch("/after-close")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
        expect(transport).toHaveBeenCalledTimes(3);
      } finally {
        await client.close();
      }
    }
  });

  it("rejects a credential without account HTTP support before transport", async () => {
    const transport = vi.spyOn(HttpTransport.prototype, "fetch");
    const client = createSarClient({
      connectionOptions: createConnectionOptions({
        account: "test",
        username: "synthetic",
        password: "synthetic",
      }),
    });
    try {
      await expect(client.fetch("/api/v2/test")).rejects.toMatchObject({
        code: "AUTH_NOT_SUPPORTED_FOR_REST",
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("rejects missing caller context before reading options", async () => {
    const getOwnerOptions = vi.fn();
    const getCallerOptions = vi.fn();
    const client = createSarClient({ connectionOptions: { getOwnerOptions, getCallerOptions } });
    try {
      expect(() => client.asCaller({ headers: new Headers() })).toThrowError(
        expect.objectContaining({ code: "CALLER_CONTEXT_REQUIRED" }),
      );
      expect(getOwnerOptions).not.toHaveBeenCalled();
      expect(getCallerOptions).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("fetches as the owner for a view without a caller token when callerAsOwner is set", async () => {
    const transport = vi
      .spyOn(HttpTransport.prototype, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const client = createSarClient({
      connectionOptions: createConnectionOptions(
        { account: "test", authenticator: "OAUTH", token: "synthetic-app" },
        { callerAsOwner: true },
      ),
    });
    try {
      await client.asCaller({ headers: new Headers() }).fetch("/api/v2/test");
      expect(new Headers(transport.mock.calls[0]![1]?.headers).get("authorization")).toBe(
        "Bearer synthetic-app",
      );
    } finally {
      await client.close();
    }
  });
});
