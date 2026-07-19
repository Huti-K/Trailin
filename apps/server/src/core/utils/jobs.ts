import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../logger.js";

/**
 * In-process job primitives: the one home for "don't run this twice at once"
 * and "at most N at a time" machinery. Deliberately no persistence and no
 * generic retry: recovery state lives in SQLite (cursors, run rows), so a
 * restart resumes from data, not a queue.
 */

/**
 * Worker-pool map: at most `limit` calls to fn in flight, items claimed in
 * order, results in input order. The first rejection propagates; workers
 * mid-item finish their current call but claim nothing further.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        // Stop sibling workers from claiming more: the first rejection is about
        // to propagate through Promise.all, so queued work would be wasted.
        next = items.length;
        throw error;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Keyed mutual exclusion with two independent domains:
 *
 * - join/isRunning: at most one run per key; a caller hitting a busy key shares
 *   the in-flight promise. Drop-when-busy callers check isRunning first (safe
 *   without a lock: no await between the check and the join).
 * - enqueue: strict serialization per key; each call runs after every earlier
 *   call for that key settles, and observes only its own rejection.
 */
export class KeyedJobs {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly chains = new Map<string, Promise<unknown>>();

  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  join<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    // Sound only while every joiner of a key asks for the same T: a busy key
    // hands back the in-flight promise as-is, unchecked.
    if (running) return running as Promise<T>;
    const run = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // The stored chain link swallows the outcome so one failed call never wedges
    // later calls; `next` still carries the real rejection to its caller.
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

export interface NightlyJobOptions {
  name: string;
  /** Fixed, server-defined cron (user-configurable schedules live in automations/scheduler.ts). */
  cron: string;
  run: (reason: "boot" | "scheduled") => Promise<void>;
}

/**
 * A fixed-schedule background job: start() fires one immediate catch-up run
 * (reason "boot") so work due while the process was down isn't stuck until the
 * next cron slot, then runs on the cron (reason "scheduled") in the given
 * timezone. A failed run is logged without killing the schedule; stop()
 * destroys the task while a run already executing finishes. node-cron bakes the
 * timezone in at creation, so a timezone change reaches a started job only via
 * reschedule().
 */
export class NightlyJob {
  private task: ScheduledTask | null = null;

  constructor(private readonly opts: NightlyJobOptions) {}

  start(timezone?: string): void {
    if (this.task) return;
    this.arm(timezone);
    void this.runSafely("boot");
  }

  stop(): void {
    if (this.task) {
      void this.task.destroy();
      this.task = null;
    }
  }

  /** Rebuild the cron task against a new timezone. No catch-up run fires; a
   *  no-op while stopped (only start() arms a stopped job). */
  reschedule(timezone?: string): void {
    if (!this.task) return;
    void this.task.destroy();
    this.arm(timezone);
  }

  private arm(timezone?: string): void {
    this.task = cron.schedule(
      this.opts.cron,
      () => void this.runSafely("scheduled"),
      timezone ? { timezone } : undefined,
    );
  }

  /** ISO time of the next scheduled run; null while stopped. */
  nextRunAt(): string | null {
    const next = this.task?.getNextRun();
    return next ? next.toISOString() : null;
  }

  private async runSafely(reason: "boot" | "scheduled"): Promise<void> {
    try {
      await this.opts.run(reason);
    } catch (error) {
      logger.warn({ err: error, job: this.opts.name, reason }, "job run failed");
    }
  }
}

export interface JobLoopOptions {
  name: string;
  run: () => Promise<void>;
  /** Poll cadence; every tick is a trigger(). */
  intervalMs: number;
  /** Coalescing window between trigger() and the run starting (default 0). */
  debounceMs?: number;
}

/**
 * A single-flight loop: interval ticks and external trigger() calls funnel into
 * the same debounced kick, a trigger landing mid-run queues exactly one
 * follow-up instead of stacking, and a failed run is logged without killing the
 * loop. Timers never keep the process alive; stop() also cancels a queued
 * follow-up.
 */
export class JobLoop {
  private interval: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running = false;
  private runAgain = false;
  private stopped = true;

  constructor(private readonly opts: JobLoopOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.trigger();
    this.interval = setInterval(() => this.trigger(), this.opts.intervalMs);
    this.interval.unref();
  }

  stop(): void {
    this.stopped = true;
    this.runAgain = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
  }

  /** Ask for a run soon; triggers while one is pending or running coalesce. */
  trigger(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.cycle();
    }, this.opts.debounceMs ?? 0);
    this.debounce.unref();
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    try {
      await this.opts.run();
    } catch (error) {
      logger.warn({ err: error, job: this.opts.name }, "job run failed");
    } finally {
      this.running = false;
      if (this.runAgain) {
        this.runAgain = false;
        this.trigger();
      }
    }
  }
}
