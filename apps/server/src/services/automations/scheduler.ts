import type { MissedAutomation } from "@trailin/shared";
import { desc, eq } from "drizzle-orm";
import cron, { type ScheduledTask } from "node-cron";
import { moduleLogger } from "../../core/logger.js";
import { KeyedJobs } from "../../core/utils/jobs.js";
import { db, schema } from "../../db/index.js";
import { getTimezoneSetting } from "../../db/settings.js";
import {
  type AutomationRunResult,
  executeAutomationRun,
  type RunTrigger,
  sweepOrphanedRuns,
} from "./runRecorder.js";

const log = moduleLogger("scheduler");

const tasks = new Map<string, ScheduledTask>();

// One run per automation at a time: a cron tick or "Run now" can't stack a
// second agent on one still working, each opening its own MCP sessions.
const runJobs = new KeyedJobs();

// Nothing may create cron tasks before boot schedules everything:
// rescheduleAll() stays inert until startScheduler() runs.
let schedulerStarted = false;

export function isValidCron(expression: string): boolean {
  return cron.validate(expression);
}

export function getNextRunAt(automationId: string): string | null {
  const next = tasks.get(automationId)?.getNextRun();
  return next ? next.toISOString() : null;
}

/** Catch-up lookback: 40 days covers a monthly schedule; older slots count as
 *  "nothing missed" rather than replaying ancient history. */
const CATCHUP_LOOKBACK_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * The most recent time `expression` would have fired at or before `notAfter`,
 * or null within the lookback window. Matches minute by minute against a
 * throwaway task built in the live timezone, the reliable way to evaluate a
 * named zone across DST without hand-rolling calendar math.
 */
export function previousCronRun(
  expression: string,
  timezone: string | undefined,
  notAfter: Date,
): Date | null {
  const task = cron.createTask(expression, () => {}, timezone ? { timezone } : undefined);
  try {
    const probe = new Date(notAfter);
    probe.setSeconds(0, 0);
    const floor = notAfter.getTime() - CATCHUP_LOOKBACK_MS;
    for (let t = probe.getTime(); t >= floor; t -= 60_000) {
      if (task.match(new Date(t))) return new Date(t);
    }
    return null;
  } finally {
    // createTask registers the task in node-cron's global map even unstarted;
    // destroy() removes it so these probes don't accumulate.
    void task.destroy();
  }
}

/** The client's "specific date" schedule shape: fixed day-of-month and month,
 *  any weekday. Cron has no year field, so this recurs annually unless retired;
 *  the caller disables it after its first success. No oneOff flag exists, so a
 *  hand-written annual cron of this shape is retired after one run too. */
function isOneOffSchedule(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, , dom, month, dow] = parts;
  return dom !== "*" && month !== "*" && dow === "*";
}

// Follow-up triggers queued while a run was in flight, drained in order by
// runAutomation. `null` is a triggerless request (a plain requestRun).
const pendingRuns = new Map<string, (RunTrigger | null)[]>();

async function runGuarded(
  automationId: string,
  opts: { manual?: boolean; trigger?: RunTrigger },
): Promise<void> {
  const result = await runJobs.join(automationId, () => executeAutomationRun(automationId, opts));
  await retireIfOneOff(automationId, result);
}

/** A completed todo may fire a paused automation: pausing stops the schedule,
 *  not the user's explicit action — so todo triggers run as manual. */
function optsFor(trigger: RunTrigger | null): { manual?: boolean; trigger?: RunTrigger } {
  return { trigger: trigger ?? undefined, manual: trigger?.kind === "todo" };
}

/** Execute one automation now (scheduler and "Run now"). `manual` may run a
 *  paused automation; scheduled ticks never may. This adds only the overlap
 *  guard and one-off retirement; runRecorder.ts owns the run itself. */
export async function runAutomation(
  automationId: string,
  opts: { manual?: boolean; trigger?: RunTrigger } = {},
): Promise<void> {
  // A tick landing while the previous run works is dropped, not stacked.
  if (runJobs.isRunning(automationId)) {
    log.warn(
      { automationId },
      "skipping run — previous run of this automation is still in progress",
    );
    return;
  }
  await runGuarded(automationId, opts);
  // Drain follow-ups requestRun queued during the run, each carrying the
  // trigger that requested it. Iterative, not recursive: a request during a
  // follow-up queues the next pass.
  for (;;) {
    const trigger = pendingRuns.get(automationId)?.shift();
    if (trigger === undefined) {
      pendingRuns.delete(automationId);
      break;
    }
    await runGuarded(automationId, optsFor(trigger));
  }
}

export function isRunInFlight(automationId: string): boolean {
  return runJobs.isRunning(automationId);
}

/**
 * Run now, queueing instead of dropping: a request during an in-flight run
 * queues a follow-up, which runAutomation drains when the run ends. Todo
 * completions queue one follow-up EACH — every completion carries its own
 * context — while other requests coalesce per kind, so a mail burst becomes
 * one follow-up pass. Entry point for the mail probe and todo chains; cron
 * ticks keep runAutomation's drop semantics. The isRunning check and the
 * mutation below share one event-loop turn (no await between them), so a
 * request can't slip past the guard.
 */
export async function requestRun(automationId: string, trigger?: RunTrigger): Promise<void> {
  const queued = trigger ?? null;
  if (runJobs.isRunning(automationId)) {
    const queue = pendingRuns.get(automationId) ?? [];
    const sameKind = (t: RunTrigger | null) => (t?.kind ?? null) === (queued?.kind ?? null);
    if (queued?.kind === "todo" || !queue.some(sameKind)) queue.push(queued);
    pendingRuns.set(automationId, queue);
    return;
  }
  await runAutomation(automationId, optsFor(queued));
}

/**
 * Enabled automations whose most recent scheduled slot elapsed uncovered:
 * node-cron fires only while the process is alive, so a slot passed while the
 * machine was off never ran. Only the latest missed slot is reported per
 * automation. A slot is covered when the most recent run started at or after it
 * and didn't error (a success, or one still in progress); a slot before
 * createdAt is ignored.
 */
export async function findMissedAutomations(now: Date = new Date()): Promise<MissedAutomation[]> {
  const timezone = (await getTimezoneSetting()) ?? undefined;
  const automations = await db.select().from(schema.automations);
  const missed: MissedAutomation[] = [];
  for (const automation of automations) {
    // An enabled automation with valid cron is always scheduled (startScheduler /
    // refreshSchedule keep that), so its schedule string says when it last fired.
    if (!automation.enabled || !isValidCron(automation.schedule)) continue;
    const due = previousCronRun(automation.schedule, timezone, now);
    if (!due || due.getTime() < new Date(automation.createdAt).getTime()) continue;

    const [last] = await db
      .select({
        startedAt: schema.automationRuns.startedAt,
        status: schema.automationRuns.status,
      })
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, automation.id))
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(1);
    const covered =
      last && new Date(last.startedAt).getTime() >= due.getTime() && last.status !== "error";
    if (covered) continue;

    missed.push({ id: automation.id, name: automation.name, dueAt: due.toISOString() });
  }
  return missed;
}

/**
 * Run every automation with an uncovered slot once now (boot catch-up and the
 * Home "run missed" button). Each goes through the same overlap guard as a
 * tick, so a real tick mid-catch-up is dropped and a just-disabled slot is
 * skipped. The missed slot travels into the run's prompt so the agent can
 * widen its window over the whole gap, not just the latest slot.
 * Fire-and-forget: returns what it started, not the outcomes.
 */
export async function runMissedAutomations(): Promise<MissedAutomation[]> {
  const missed = await findMissedAutomations();
  for (const item of missed) {
    log.info({ automationId: item.id, dueAt: item.dueAt }, "catching up missed automation run");
    runAutomation(item.id, { trigger: { kind: "catchUp", dueAt: item.dueAt } }).catch(
      (error: unknown) => log.error({ err: error, automationId: item.id }, "catch-up run failed"),
    );
  }
  return missed;
}

/** Retire (disable + unschedule) a one-off automation once its single run
 *  succeeded; a failed or never-started one is left retryable. */
async function retireIfOneOff(automationId: string, result: AutomationRunResult): Promise<void> {
  if (!result.started || !result.schedule || !isOneOffSchedule(result.schedule)) return;
  if (result.succeeded) {
    await db
      .update(schema.automations)
      .set({ enabled: false })
      .where(eq(schema.automations.id, automationId));
    unschedule(automationId);
    return;
  }
  log.warn(
    { automationId },
    "one-off automation run failed — not retiring it so it stays scheduled for a retry",
  );
}

async function schedule(automation: { id: string; schedule: string }): Promise<void> {
  // "0 6 * * *" should mean 6am in the user's timezone, not the server's.
  const timezone = (await getTimezoneSetting()) ?? undefined;
  // Destroy any task already registered for this id before overwriting the map
  // entry, so a lost race can never leave an untracked task still firing.
  const stale = tasks.get(automation.id);
  if (stale) void stale.destroy();
  const task = cron.schedule(
    automation.schedule,
    () => {
      // runAutomation records its own failures; this catches only what it couldn't.
      runAutomation(automation.id).catch((error: unknown) =>
        log.error({ err: error, automationId: automation.id }, "scheduled automation failed"),
      );
    },
    timezone ? { timezone } : undefined,
  );
  tasks.set(automation.id, task);
}

export function unschedule(automationId: string): void {
  const task = tasks.get(automationId);
  if (task) {
    // destroy() (not stop()) also removes the task from node-cron's registry.
    void task.destroy();
    tasks.delete(automationId);
  }
}

// Serializes schedule mutations per automation id: refreshSchedule and
// rescheduleAll funnel through this queue, so two concurrent callers for one id
// can't interleave their unschedule/select/schedule steps and clobber the map.
const scheduleJobs = new KeyedJobs();

async function applySchedule(automationId: string): Promise<void> {
  unschedule(automationId);
  const [automation] = await db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.id, automationId));
  if (automation?.enabled && isValidCron(automation.schedule)) {
    await schedule(automation);
  }
}

export async function refreshSchedule(automationId: string): Promise<void> {
  return scheduleJobs.enqueue(automationId, () => applySchedule(automationId));
}

/**
 * Rebuild every enabled automation's task against the current timezone.
 * node-cron bakes the timezone in at creation, so a timezone change takes
 * effect only once tasks are recreated; call this after it changes.
 */
export async function rescheduleAll(): Promise<void> {
  if (!schedulerStarted) return;
  const all = await db.select().from(schema.automations);
  for (const automation of all) {
    // Same per-id queue as refreshSchedule, so this can't interleave with a
    // concurrent edit's refreshSchedule call.
    await scheduleJobs.enqueue(automation.id, () => applySchedule(automation.id));
  }
}

export async function startScheduler(): Promise<void> {
  await sweepOrphanedRuns();

  const all = await db.select().from(schema.automations);
  for (const automation of all) {
    if (automation.enabled && isValidCron(automation.schedule)) {
      await schedule(automation);
    }
  }
  schedulerStarted = true;
  log.info({ count: tasks.size }, "automations scheduled");

  // Catch up on slots the machine slept through (node-cron fires only while
  // alive). Off the boot critical path; the runs it starts record themselves.
  void runMissedAutomations().catch((error: unknown) =>
    log.error({ err: error }, "boot catch-up failed"),
  );
}

/** Destroy every cron task and re-latch; only startScheduler() re-arms. */
export function stopScheduler(): void {
  schedulerStarted = false;
  for (const task of tasks.values()) void task.destroy();
  tasks.clear();
}
