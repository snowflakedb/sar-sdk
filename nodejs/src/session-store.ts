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

import type snowflake from "snowflake-sdk";
import { destroy } from "./driver-adapter.js";
import { fail } from "./errors.js";
import { Budget, checkAbort, deadline } from "./lifecycle.js";
import type { PoolOptions } from "./types.js";

/** Session settings the SDK applied; an application reset hook starts a new one. */
export type SessionState = { jsonFormats?: boolean };

type Resource = {
  connection: snowflake.Connection;
  scope: object;
  warehouse?: string;
  created: number;
  idle: boolean;
  idleSince?: number;
  releaseSlot: () => void;
  timer?: ReturnType<typeof setTimeout>;
  destroying?: Promise<void>;
  deferLogout: boolean;
  state: SessionState;
};

type Parked = Pick<Resource, "connection" | "warehouse" | "created" | "state"> & {
  reusable: boolean;
};

const callerLogoutDelayMs = 60_000;

/** Physical permits outlive caller deadlines when a driver destroy is still pending. */
export class SessionStore {
  readonly resources = new Set<Resource>();
  readonly slots: Budget;
  private readonly parked = new Map<
    object,
    { sessions: Parked[]; timer?: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private readonly reuse: Extract<PoolOptions, { mode: "reusable" }> | undefined;
  constructor(options: PoolOptions = {}) {
    this.slots = new Budget(options.maxConnections ?? 10, options.maxConnections ?? 10);
    this.reuse =
      options.mode === "reusable" ? { ...options, reset: options.reset.bind(options) } : undefined;
  }
  get idle() {
    return [...this.resources].filter((resource) => resource.idle).length;
  }
  async checkout(
    scope: object,
    warehouse: string | undefined,
    timeout: number,
    signal: AbortSignal,
    fresh = false,
  ): Promise<{ resource?: Resource; releaseSlot?: () => void }> {
    checkAbort(signal);
    if (this.closed) fail("CLIENT_CLOSED", "Session store is closed");
    this.postponeLogout(scope);
    const now = performance.now();
    for (const resource of this.resources) {
      if (
        resource.idle &&
        (now - resource.created >= (this.reuse?.maxLifetimeMs ?? 1800_000) ||
          now - resource.idleSince! >= (this.reuse?.idleTimeoutMs ?? 60_000))
      ) {
        void this.discard(resource).catch(() => {});
        continue;
      }
      if (
        !fresh &&
        resource.idle &&
        resource.scope === scope &&
        resource.warehouse === warehouse &&
        performance.now() - resource.created < (this.reuse?.maxLifetimeMs ?? 1800_000)
      ) {
        resource.idle = false;
        clearTimeout(resource.timer);
        return { resource };
      }
    }
    const parked = fresh ? undefined : this.unpark(scope, warehouse);
    const eviction =
      this.slots.active >= this.slots.maximum
        ? [...this.resources].find((resource) => resource.idle)
        : undefined;
    if (eviction) void this.discard(eviction).catch(() => {});
    let releaseSlot: () => void;
    try {
      releaseSlot = await this.slots.acquire(timeout, signal);
    } catch (error) {
      if (parked) this.park(scope, parked);
      throw error;
    }
    if (!parked) return { releaseSlot };
    const { connection, created, state } = parked;
    return {
      resource: this.attach(connection, scope, warehouse, releaseSlot, true, state, created),
    };
  }
  attach(
    connection: snowflake.Connection,
    scope: object,
    warehouse: string | undefined,
    releaseSlot: () => void,
    deferLogout = false,
    state: SessionState = {},
    created = performance.now(),
  ): Resource {
    const resource = {
      connection,
      scope,
      warehouse,
      created,
      idle: false,
      releaseSlot,
      deferLogout,
      state,
    };
    this.resources.add(resource);
    return resource;
  }
  /** A reusable caller session is parked for the same view's next operation. */
  discard(resource: Resource, reusable = false): Promise<void> {
    if (resource.destroying) return resource.destroying;
    resource.idle = false;
    clearTimeout(resource.timer);
    if (resource.deferLogout && !this.closed) {
      resource.destroying = Promise.resolve();
      this.resources.delete(resource);
      resource.releaseSlot();
      const { connection, warehouse, created, state } = resource;
      this.park(resource.scope, { connection, warehouse, created, state, reusable });
      return resource.destroying;
    }
    const pending = Promise.resolve()
      .then(() => destroy(resource.connection))
      .finally(() => {
        this.resources.delete(resource);
        resource.releaseSlot();
      });
    resource.destroying = deadline(pending, 5_000, undefined, "Session cleanup");
    return resource.destroying;
  }
  async release(resource: Resource, reusable: boolean, signal: AbortSignal): Promise<void> {
    if (resource.destroying) return resource.destroying;
    if (!this.reuse) return this.discard(resource, reusable && !signal.aborted);
    if (
      !reusable ||
      this.closed ||
      signal.aborted ||
      performance.now() - resource.created >= (this.reuse.maxLifetimeMs ?? 1800_000)
    )
      return this.discard(resource);
    try {
      const resetting = Promise.resolve().then(() => {
        const result = this.reuse!.reset(resource.connection);
        if (!result || typeof result.then !== "function")
          fail("INVALID_OPTIONS", "Pool reset must return a Promise");
        return result;
      });
      await deadline(resetting, this.reuse.resetTimeoutMs ?? 5_000, signal, "Session reset");
    } catch (error) {
      await this.discard(resource).catch(() => {});
      throw error;
    }
    resource.state = {};
    if (
      this.closed ||
      signal.aborted ||
      this.slots.queued ||
      performance.now() - resource.created >= (this.reuse.maxLifetimeMs ?? 1800_000)
    )
      return this.discard(resource);
    resource.idle = true;
    resource.idleSince = performance.now();
    resource.timer = setTimeout(
      () => {
        void this.discard(resource).catch(() => {});
      },
      Math.min(
        this.reuse.idleTimeoutMs ?? 60_000,
        (this.reuse.maxLifetimeMs ?? 1800_000) - (performance.now() - resource.created),
      ),
    );
    resource.timer.unref();
  }
  async closeIdle(): Promise<void> {
    this.closed = true;
    this.slots.close();
    await Promise.all([
      ...[...this.resources]
        .filter((resource) => resource.idle || resource.destroying)
        .map((resource) => this.discard(resource)),
      ...[...this.parked.keys()].map((scope) => this.logout(scope)),
    ]);
  }
  /**
   * Snowflake stops accepting a caller token for new logins once any session made from it logs
   * out, and the token itself expires after two minutes by default. So a caller view keeps its
   * sessions for its later operations and logs them out together after the view has had no
   * session in use for a while, or at shutdown. Parked sessions don't hold a physical slot.
   */
  private park(scope: object, session: Parked): void {
    const entry = this.parked.get(scope) ?? { sessions: [] };
    entry.sessions.push(session);
    this.parked.set(scope, entry);
    this.postponeLogout(scope);
  }
  private unpark(scope: object, warehouse: string | undefined): Parked | undefined {
    const sessions = this.parked.get(scope)?.sessions ?? [];
    for (let index = sessions.length - 1; index >= 0; index--) {
      const session = sessions[index]!;
      if (session.reusable && session.warehouse === warehouse) return sessions.splice(index, 1)[0];
    }
    return undefined;
  }
  private postponeLogout(scope: object): void {
    const entry = this.parked.get(scope);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const inUse = [...this.resources].some(
        (resource) => resource.scope === scope && !resource.idle,
      );
      if (inUse) this.postponeLogout(scope);
      else void this.logout(scope).catch(() => {});
    }, callerLogoutDelayMs);
    entry.timer.unref();
  }
  private logout(scope: object): Promise<void> {
    const entry = this.parked.get(scope);
    if (!entry) return Promise.resolve();
    this.parked.delete(scope);
    clearTimeout(entry.timer);
    return Promise.all(
      entry.sessions.map(({ connection }) =>
        deadline(destroy(connection), 5_000, undefined, "Session cleanup"),
      ),
    ).then(() => {});
  }
}
