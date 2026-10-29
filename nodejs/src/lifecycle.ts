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

import { SarError, fail } from "./errors.js";
import type { LogEvent } from "./types.js";

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SarError("ABORTED", "Operation aborted");
}

/** Wraps a logger to ignore its exceptions and rejections. */
export function safeLogger(logger: unknown): ((event: LogEvent) => void) | undefined {
  if (typeof logger !== "function") return undefined;
  return (event) => {
    try {
      void Promise.resolve((logger as (event: LogEvent) => void)(event)).catch(() => {});
    } catch {
      /* Logging cannot change an operation. */
    }
  };
}

/** Whole milliseconds since a performance.now() reading. */
export const elapsed = (since: number) => Math.round(performance.now() - since);

export function deadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  phase = "operation",
  expires = performance.now() + timeoutMs,
  timeoutError?: Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new SarError("ABORTED", `${phase} aborted`)));
    const expire = () =>
      finish(() => reject(timeoutError ?? new SarError("TIMEOUT", `${phase} deadline exceeded`)));
    const timer = setTimeout(expire, Math.max(0, expires - performance.now()));
    let done = false;
    function finish(action: () => void) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => {
        if (performance.now() >= expires) expire();
        else finish(() => resolve(value));
      },
      (error) => finish(() => reject(error)),
    );
  });
}

export async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class Budget {
  active = 0;
  closed = false;
  private queue: { grant: () => void; cancel: (error: Error) => void }[] = [];
  get queued() {
    return this.queue.length;
  }
  constructor(
    readonly maximum: number,
    readonly maxQueue: number,
  ) {}
  async acquire(timeout: number, signal?: AbortSignal): Promise<() => void> {
    if (this.closed) fail("CLIENT_CLOSED", "Client is closed");
    if (signal?.aborted) fail("ABORTED", "Acquisition aborted");
    if (this.active < this.maximum) {
      this.active++;
      return this.releaseFunction();
    }
    if (this.queue.length >= this.maxQueue) fail("QUEUE_FULL", "Connection queue is full");
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.queue = this.queue.filter((item) => item !== entry);
        return true;
      };
      const entry = {
        grant: () => {
          if (finish()) {
            this.active++;
            resolve(this.releaseFunction());
          }
        },
        cancel: (error: Error) => {
          if (finish()) reject(error);
        },
      };
      const abort = () => entry.cancel(new SarError("ABORTED", "Connection acquisition aborted"));
      const timer = setTimeout(
        () => entry.cancel(new SarError("TIMEOUT", "Connection acquisition deadline exceeded")),
        timeout,
      );
      this.queue.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  /** Counts a permit for something that already exists, even past the maximum. */
  force(): () => void {
    this.active++;
    return this.releaseFunction();
  }
  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.closed) this.queue[0]?.grant();
    };
  }
  close(): void {
    this.closed = true;
    for (const entry of [...this.queue])
      entry.cancel(new SarError("CLIENT_CLOSED", "Client is closed"));
  }
}
