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
import { fail } from "./errors.js";
import { Budget, checkAbort, deadline } from "./lifecycle.js";
import type { DriverModule, PoolOptions } from "./types.js";

/** Session settings the SDK applied; an application reset hook starts a new one. */
export type SessionState = { jsonFormats?: boolean };

type CreatePool = DriverModule["createPool"];

/**
 * How a partition's sessions end: owned sessions are logged out, or kept for reuse in reusable
 * mode; caller sessions wait for their view's logout; detached sessions are never reused.
 */
export type SessionKind = "owned" | "caller" | "detached";

/** The driver pool for one scope, warehouse, and kind of session. */
type Partition = {
  readonly pool: ReturnType<CreatePool>;
  readonly scope: object;
  readonly key: string;
  readonly kind: SessionKind;
  /** The pool's factory reads these for each connection it creates, so they're refreshed in place. */
  readonly options: Record<string, unknown>;
  /** Idle connections to take out of service the next time the pool's idle connections are taken. */
  readonly evicting: Set<snowflake.Connection>;
  /** Caller sessions that can't be reused; they stay borrowed until the view logs out. */
  readonly held: Set<Resource>;
  /** The last options the factory built a connection with. */
  valid?: Record<string, unknown>;
  retired: boolean;
};

export type Resource = {
  connection: snowflake.Connection;
  partition: Partition;
  created: number;
  idle: boolean;
  idleSince?: number;
  /** The physical slot this session holds, if it counts toward maxConnections. */
  slot?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Settles once the session can't be used again: held, or logged out. */
  destroying?: Promise<void>;
  /** The logout, bounded by the cleanup deadline. */
  ending?: Promise<void>;
  /** Settles when the connection's logout finishes. */
  closed: Promise<void>;
  state: SessionState;
};

const callerLogoutDelayMs = 60_000;

function replace(target: Record<string, unknown>, source: object): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/**
 * Sessions come from the driver's connection pools. The store adds what those pools don't: one
 * physical limit across all of them, reset and lifetime limits for reuse, caller views' deferred
 * logout, and logout tracking. Physical permits outlive caller deadlines while a logout is pending.
 */
export class SessionStore {
  readonly resources = new Set<Resource>();
  readonly slots: Budget;
  private readonly partitions = new Map<object, Map<string, Partition>>();
  private readonly logouts = new Map<object, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly reuse: Extract<PoolOptions, { mode: "reusable" }> | undefined;
  private readonly driverPoolOptions: PoolOptions["driverPoolOptions"];
  constructor(options: PoolOptions = {}) {
    this.slots = new Budget(options.maxConnections ?? 10, options.maxConnections ?? 10);
    this.driverPoolOptions = options.driverPoolOptions;
    this.reuse =
      options.mode === "reusable" ? { ...options, reset: options.reset.bind(options) } : undefined;
  }
  get idle() {
    return [...this.resources].filter((resource) => resource.idle && resource.slot).length;
  }
  private get idleTimeout() {
    return this.reuse?.idleTimeoutMs ?? 60_000;
  }
  private get lifetime() {
    return this.reuse?.maxLifetimeMs ?? 1800_000;
  }
  /** Whether idle sessions of this kind keep their physical slot. */
  counts(kind: SessionKind): boolean {
    return kind !== "detached" && this.reuse !== undefined;
  }
  /** The driver pool for a scope, warehouse, and kind of session, created on first use. */
  partition(
    scope: object,
    warehouse: string | undefined,
    kind: SessionKind,
    createPool: CreatePool,
  ): Partition {
    if (this.closed) fail("CLIENT_CLOSED", "Session store is closed");
    const pools = this.partitions.get(scope) ?? new Map<string, Partition>();
    this.partitions.set(scope, pools);
    const key = JSON.stringify([kind, warehouse ?? null]);
    let partition = pools.get(key);
    if (!partition) {
      const options: Record<string, unknown> = {};
      partition = {
        pool: createPool(options as snowflake.ConnectionOptions, {
          ...this.driverPoolOptions,
          max: this.slots.maximum,
          min: 0,
          idleTimeoutMillis: this.idleTimeout,
        }),
        scope,
        key,
        kind,
        options,
        evicting: new Set(),
        held: new Set(),
        retired: false,
      };
      pools.set(key, partition);
    }
    return partition;
  }
  /**
   * An idle session still within its idle timeout and lifetime, if the pool has one. Idle
   * sessions that don't count toward maxConnections take the slot the caller reserved.
   */
  async borrow(partition: Partition, slot?: () => void): Promise<Resource | undefined> {
    if (partition.kind === "caller") this.postponeLogout(partition.scope);
    while (!partition.retired && partition.pool.available > 0) {
      const resource = this.adopt(partition, await partition.pool.acquire(), slot)?.resource;
      if (!resource) continue;
      if (!this.expired(resource)) {
        resource.idleSince = undefined;
        return resource;
      }
      if (slot && resource.slot === slot) resource.slot = undefined;
      void this.discard(resource).catch(() => {});
    }
    return undefined;
  }
  /** A physical slot for a session, closing another scope's idle session if needed. */
  async reserve(partition: Partition, timeout: number, signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.closed) fail("CLIENT_CLOSED", "Session store is closed");
    if (partition.kind === "caller") this.postponeLogout(partition.scope);
    this.evict(partition);
    return this.slots.acquire(timeout, signal);
  }
  /** Has the driver pool log in with these options, for a borrower holding a slot. */
  async open(
    partition: Partition,
    options: snowflake.ConnectionOptions,
    slot: () => void,
  ): Promise<{ resource: Resource; opened: boolean }> {
    replace(partition.options, options);
    for (;;) {
      if (partition.retired) {
        slot();
        fail("AUTH_FAILED", "The session pool stopped accepting logins");
      }
      const creating = partition.pool.available === 0;
      let request: Promise<snowflake.Connection>;
      try {
        request = partition.pool.acquire();
      } catch (error) {
        slot();
        this.retire(partition);
        throw error;
      }
      if (creating) partition.valid = { ...options };
      let connection: snowflake.Connection;
      try {
        connection = await request;
      } catch (error) {
        slot();
        this.prune(partition);
        throw error;
      }
      const adopted = this.adopt(partition, connection, slot);
      if (adopted) return adopted;
    }
  }
  /**
   * Tracks a connection the pool handed out. The pool can hand any idle or newly created
   * connection to any borrower, so the borrower's slot goes to whichever one it gets, unless that
   * one already holds a slot. A new connection nobody holds a slot for, created for a request the
   * driver already failed, is counted as it is. Returns nothing for a session taken out of service
   * while the pool was handing it out.
   */
  private adopt(
    partition: Partition,
    connection: snowflake.Connection,
    slot?: () => void,
  ): { resource: Resource; opened: boolean } | undefined {
    const known = [...this.resources].find((resource) => resource.connection === connection);
    if (known?.destroying) {
      partition.evicting.delete(connection);
      known.idle = false;
      if (partition.kind === "caller" && !this.closed) this.hold(known);
      else void this.destroy(known).catch(() => {});
      return undefined;
    }
    if (known) {
      known.idle = false;
      clearTimeout(known.timer);
      if (known.slot) slot?.();
      else known.slot = slot ?? this.slots.force();
      return { resource: known, opened: false };
    }
    let settle!: (error?: unknown) => void;
    const resource: Resource = {
      connection,
      partition,
      created: performance.now(),
      idle: false,
      slot: slot ?? this.slots.force(),
      closed: new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      }),
      state: {},
    };
    resource.closed.catch(() => {});
    this.resources.add(resource);
    // The driver pool's factory resolves destroy() even when logout fails, and the pool doesn't
    // await it, so the connection's own destroy reports both.
    const destroyConnection = connection.destroy;
    let finished = false;
    connection.destroy = (callback) =>
      destroyConnection.call(connection, (error, closed) => {
        if (!finished) {
          finished = true;
          resource.idle = false;
          clearTimeout(resource.timer);
          this.resources.delete(resource);
          resource.slot?.();
          resource.slot = undefined;
          settle(error);
          this.prune(partition);
        }
        callback(error, closed);
      });
    return { resource, opened: true };
  }
  /**
   * The driver's factory builds a connection inside the pool's acquire(), so an error it throws
   * there leaves the pool holding a request it never settles and would give the next connection.
   * Restoring the last options that worked keeps connections already being created from throwing
   * as well; the pool is then cleared and not used again.
   */
  private retire(partition: Partition): void {
    partition.retired = true;
    this.forget(partition);
    replace(partition.options, partition.valid ?? {});
    for (const resource of this.resources)
      if (resource.partition === partition && resource.idle)
        void this.destroy(resource).catch(() => {});
    void partition.pool.clear().catch(() => {});
  }
  /** Drops an owned or detached partition once its pool has no connections left. */
  private prune(partition: Partition): void {
    const { pool } = partition;
    if (partition.kind === "caller" || partition.retired || pool.size > 0 || pool.pending > 0)
      return;
    if (this.forget(partition))
      void pool
        .drain()
        .then(() => pool.clear())
        .catch(() => {});
  }
  private forget(partition: Partition): boolean {
    const pools = this.partitions.get(partition.scope);
    if (pools?.get(partition.key) !== partition) return false;
    pools.delete(partition.key);
    if (!pools.size) this.partitions.delete(partition.scope);
    return true;
  }
  /** Returns or destroys a borrowed connection; the pool may then create one for a waiting request. */
  private dispatch(
    partition: Partition,
    action: "release" | "destroy",
    connection: snowflake.Connection,
  ): void {
    try {
      void partition.pool[action](connection).catch(() => {});
    } catch {
      this.retire(partition);
    }
  }
  private expired(resource: Resource, now = performance.now()): boolean {
    return (
      now - resource.created >= this.lifetime ||
      (resource.idleSince !== undefined && now - resource.idleSince >= this.idleTimeout)
    );
  }
  /** Frees a physical slot by taking an idle session that holds one out of service, if any. */
  private evict(exclude: Partition): void {
    if (this.slots.active < this.slots.maximum) return;
    const idle = [...this.resources].find(
      (resource) =>
        resource.idle &&
        resource.slot &&
        resource.partition !== exclude &&
        !resource.partition.retired &&
        resource.partition.pool.available > 0,
    );
    if (idle) void this.discard(idle).catch(() => {});
  }
  /**
   * Takes all of a pool's idle connections, since the pool can't hand out a specific one, then
   * takes the marked and expired ones out of service, or all of them, and returns the rest.
   */
  private async sweep(partition: Partition, all = false): Promise<Promise<void>[]> {
    if (partition.retired) return [];
    const taken = await Promise.all(
      Array.from({ length: partition.pool.available }, () => partition.pool.acquire()),
    );
    const endings: Promise<void>[] = [];
    for (const connection of taken) {
      let resource = [...this.resources].find((candidate) => candidate.connection === connection);
      if (!resource) {
        resource = this.adopt(partition, connection)!.resource;
        resource.idleSince = performance.now();
      }
      resource.idle = false;
      if (
        all ||
        partition.evicting.delete(connection) ||
        resource.destroying ||
        this.closed ||
        this.expired(resource)
      ) {
        if (partition.kind === "caller" && !all && !this.closed) this.hold(resource);
        else endings.push(this.destroy(resource));
      } else {
        resource.idle = true;
        if (!this.counts(partition.kind)) {
          resource.slot?.();
          resource.slot = undefined;
        }
        this.dispatch(partition, "release", connection);
      }
    }
    return endings;
  }
  /**
   * Snowflake stops accepting a caller token for new logins once any session made from it logs
   * out, so a caller session that can't be reused stays borrowed, without a physical slot, until
   * its view logs out.
   */
  private hold(resource: Resource): void {
    resource.idle = false;
    clearTimeout(resource.timer);
    resource.slot?.();
    resource.slot = undefined;
    this.resources.delete(resource);
    resource.partition.held.add(resource);
    resource.destroying ??= Promise.resolve();
    this.postponeLogout(resource.partition.scope);
  }
  /** Logs a session out through its pool. */
  private destroy(resource: Resource): Promise<void> {
    const { partition, connection } = resource;
    const idle = resource.idle;
    resource.idle = false;
    clearTimeout(resource.timer);
    resource.ending ??= deadline(resource.closed, 5_000, undefined, "Session cleanup");
    resource.destroying = resource.ending;
    // A retired pool's clear() logs out its idle sessions.
    if (partition.retired) {
      if (!idle) connection.destroy(() => {});
    } else if (idle) {
      partition.evicting.add(connection);
      void this.sweep(partition).catch(() => {});
    } else this.dispatch(partition, "destroy", connection);
    return resource.ending;
  }
  /** Takes a session out of service: caller sessions are held for their view's logout. */
  discard(resource: Resource): Promise<void> {
    if (resource.destroying) return resource.destroying;
    if (resource.partition.kind !== "caller" || this.closed) return this.destroy(resource);
    if (resource.idle) {
      resource.destroying = Promise.resolve();
      resource.partition.evicting.add(resource.connection);
      void this.sweep(resource.partition).catch(() => {});
    } else this.hold(resource);
    return resource.destroying!;
  }
  async release(resource: Resource, reusable: boolean, signal: AbortSignal): Promise<void> {
    if (resource.destroying) return resource.destroying;
    const { partition } = resource;
    const reusableKind = partition.kind === "caller" || (partition.kind === "owned" && this.reuse);
    if (
      !reusableKind ||
      !reusable ||
      this.closed ||
      signal.aborted ||
      performance.now() - resource.created >= this.lifetime
    )
      return this.discard(resource);
    if (this.reuse) {
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
        performance.now() - resource.created >= this.lifetime
      )
        return this.discard(resource);
    }
    if (partition.retired) return this.discard(resource);
    this.dispatch(partition, "release", resource.connection);
    // The pool hands a returned connection straight to a borrower that's already waiting.
    if (partition.pool.isBorrowedResource(resource.connection)) return;
    resource.idle = true;
    resource.idleSince = performance.now();
    if (partition.kind === "caller") this.postponeLogout(partition.scope);
    if (!this.counts(partition.kind)) {
      resource.slot?.();
      resource.slot = undefined;
      return;
    }
    resource.timer = setTimeout(
      () => {
        void this.discard(resource).catch(() => {});
      },
      Math.min(this.idleTimeout, this.lifetime - (performance.now() - resource.created)),
    );
    resource.timer.unref();
  }
  async closeIdle(): Promise<void> {
    this.closed = true;
    this.slots.close();
    for (const timer of this.logouts.values()) clearTimeout(timer);
    this.logouts.clear();
    const partitions = [...this.partitions.values()].flatMap((pools) => [...pools.values()]);
    this.partitions.clear();
    await Promise.all([
      ...[...this.resources].flatMap((resource) => resource.ending ?? []),
      ...partitions.map((partition) => this.end(partition)),
    ]);
  }
  /** Logs out every session of a partition once its borrowed ones are back. */
  private async end(partition: Partition): Promise<void> {
    const held = [...partition.held].map((resource) => {
      partition.held.delete(resource);
      return this.destroy(resource);
    });
    const idle = await this.sweep(partition, true);
    await Promise.all([
      ...held,
      ...idle,
      // clear() also logs out connections still being created for borrowers given another one.
      ...(partition.retired ? [] : [partition.pool.drain().then(() => partition.pool.clear())]),
    ]);
  }
  /**
   * Snowflake stops accepting a caller token for new logins once any session made from it logs
   * out, and the token itself expires after two minutes by default. So a caller view keeps its
   * sessions for its later operations and logs them out together after the view has had no
   * session in use for a while, or at shutdown.
   */
  private postponeLogout(scope: object): void {
    if (this.closed) return;
    clearTimeout(this.logouts.get(scope));
    const timer = setTimeout(() => {
      const inUse = [...this.resources].some(
        (resource) => resource.partition.scope === scope && !resource.idle,
      );
      if (inUse) this.postponeLogout(scope);
      else void this.logout(scope).catch(() => {});
    }, callerLogoutDelayMs);
    timer.unref();
    this.logouts.set(scope, timer);
  }
  private async logout(scope: object): Promise<void> {
    this.logouts.delete(scope);
    const pools = this.partitions.get(scope);
    this.partitions.delete(scope);
    await Promise.all([...(pools?.values() ?? [])].map((partition) => this.end(partition)));
  }
}
