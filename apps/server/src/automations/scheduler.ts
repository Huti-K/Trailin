import type { MissedAutomation } from "@trailin/shared";
import { desc, eq } from "drizzle-orm";
import cron, { type ScheduledTask } from "node-cron";
import { db, schema } from "../db/index.js";
import { getTimezoneSetting } from "../db/settings.js";
import { moduleLogger } from "../logger.js";
import { KeyedJobs } from "../utils/jobs.js";
import {
  type AutomationRunResult,
  executeAutomationRun,
  sweepOrphanedRuns,
} from "./runRecorder.js";

const log = moduleLogger("scheduler");

const tasks = new Map<string, ScheduledTask>();

// One run per automation at a time, so a cron tick (or a "Run now" click)
// can't stack a second agent on top of one still working — on a tight
// schedule that piled up concurrent runs, each opening its own MCP sessions.
const runJobs = new KeyedJobs();

// Nothing may create cron tasks before boot has scheduled everything —
// rescheduleAll() has to stay inert until startScheduler() runs.
let schedulerStarted = false;

export function isValidCron(expression: string): boolean {
  return cron.validate(expression);
}

/** Next scheduled fire time for an automation, or null when it isn't scheduled (disabled/invalid). */
export function getNextRunAt(automationId: string): string | null {
  const next = tasks.get(automationId)?.getNextRun();
  return next ? next.toISOString() : null;
}

/** How far back catch-up looks for a missed slot. 40 days covers a monthly
 *  schedule; a slot older than this is treated as "nothing missed" rather than
 *  replaying ancient history the user no longer cares about. */
const CATCHUP_LOOKBACK_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * The most recent time a cron expression would have fired at or before
 * `notAfter`, or null when it wouldn't have within the lookback window. Cron
 * resolves to the minute, so this walks back minute by minute, matching each
 * candidate against a throwaway (never-started) task built with the same
 * timezone the live schedule uses — the reliable way to evaluate a pattern in a
 * named zone across DST without hand-rolling the calendar math.
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
    // createTask registers the task in node-cron's global map even though it
    // never starts; destroy() removes it so these probes don't accumulate.
    void task.destroy();
  }
}

/** True for the client's "specific date" schedule shape: a fixed day-of-month
 *  and month, matched on any weekday. Plain cron has no year field, so left
 *  alone this would recur annually — the caller disables the automation
 *  after this first *successful* run so it behaves as a one-time schedule.
 *  Nothing in the automation row or the API distinguishes this from a
 *  hand-written annual cron like "0 9 15 3 *" (no oneOff/type flag exists
 *  anywhere), so an annual cron that happens to match this shape is retired
 *  after its first run too. Accepted as the closest guess available without
 *  a schema change. */
function isOneOffSchedule(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, , dom, month, dow] = parts;
  return dom !== "*" && month !== "*" && dow === "*";
}

// Automation ids asked to run again while a run of theirs was in flight. A Set,
// so however many requests land mid-run, each automation gets exactly one
// follow-up (the follow-up sees everything that arrived during the run).
const pendingRuns = new Set<string>();

/** One overlap-guarded run: execute, then retire a one-off schedule that succeeded. */
async function runGuarded(automationId: string, opts: { manual?: boolean }): Promise<void> {
  const result = await runJobs.join(automationId, () => executeAutomationRun(automationId, opts));
  await retireIfOneOff(automationId, result);
}

/** Execute one automation now (used by the scheduler and the "Run now" button).
 *  `manual` marks an explicit user-triggered run, which may run a paused
 *  automation; scheduled ticks never may. Run-row/Conversation bookkeeping,
 *  the agent turn, and the timeout are runRecorder.ts's job; this only adds
 *  the overlap guard and, once runRecorder reports back, retires a one-off
 *  schedule that succeeded. */
export async function runAutomation(
  automationId: string,
  opts: { manual?: boolean } = {},
): Promise<void> {
  // A cron tick (or a second "Run now") that lands while the previous run is
  // still working is dropped, not stacked.
  if (runJobs.isRunning(automationId)) {
    log.warn(
      { automationId },
      "skipping run — previous run of this automation is still in progress",
    );
    return;
  }
  await runGuarded(automationId, opts);
  // Follow-ups queued by requestRun while the run above (or a follow-up below)
  // was in flight. Draining here — not in requestRun — keeps the coalescing
  // invariant whoever started the run: a mail burst landing mid-run yields one
  // catch-up pass even when the running instance came from a cron tick or the
  // "Run now" button. The loop is iterative on purpose: a request landing
  // during a follow-up queues the next pass instead of recursing. Follow-ups
  // always run non-manual — they stand in for requestRun calls, not for
  // whatever triggered the run they queued behind.
  while (pendingRuns.delete(automationId)) {
    await runGuarded(automationId, {});
  }
}

/** Whether a run of this automation is executing right now. */
export function isRunInFlight(automationId: string): boolean {
  return runJobs.isRunning(automationId);
}

/**
 * Run an automation now, coalescing instead of dropping: a request landing
 * while a run is in flight queues exactly one follow-up run, however many
 * such requests arrive — runAutomation drains the queue when the in-flight
 * run finishes. The mail probe's entry point. Cron ticks keep runAutomation's
 * drop semantics. The isRunning check and the runAutomation call below share
 * one event-loop turn (no await between them), the same atomicity KeyedJobs
 * documents for its drop-when-busy callers.
 */
export async function requestRun(automationId: string): Promise<void> {
  if (runJobs.isRunning(automationId)) {
    pendingRuns.add(automationId);
    return;
  }
  await runAutomation(automationId);
}

/**
 * Enabled automations whose most recent scheduled slot elapsed without being
 * covered by a run — node-cron only fires while the process is alive, so a slot
 * that passed while the machine was asleep or off never ran. "Run once": only
 * the latest missed slot is reported per automation, however many were skipped.
 *
 * A slot counts as covered when the automation's most recent run started at or
 * after it and did not error — a success, or a run still in progress (so a
 * catch-up already underway isn't reported as still-missed). A slot earlier
 * than the automation's createdAt is ignored, since the automation didn't exist
 * to run then.
 */
export async function findMissedAutomations(now: Date = new Date()): Promise<MissedAutomation[]> {
  const timezone = (await getTimezoneSetting()) ?? undefined;
  const automations = await db.select().from(schema.automations);
  const missed: MissedAutomation[] = [];
  for (const automation of automations) {
    // An enabled automation with a valid cron is always scheduled (startScheduler
    // / refreshSchedule keep that invariant), so the schedule string alone tells
    // us when it should have last fired.
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
 * Run every automation with an uncovered past slot once, now — the shared body
 * of boot catch-up (startScheduler) and the Home "run missed" button. Each goes
 * through the same overlap-guarded path as a scheduled tick, so a real tick that
 * lands mid-catch-up is dropped rather than stacked, and a slot the user just
 * disabled is re-checked and skipped by executeAutomationRun. Fire-and-forget:
 * returns the automations it kicked off, not their outcomes.
 */
export async function runMissedAutomations(): Promise<MissedAutomation[]> {
  const missed = await findMissedAutomations();
  for (const item of missed) {
    log.info({ automationId: item.id, dueAt: item.dueAt }, "catching up missed automation run");
    runAutomation(item.id).catch((error: unknown) =>
      log.error({ err: error, automationId: item.id }, "catch-up run failed"),
    );
  }
  return missed;
}

/** Disable and unschedule a one-off automation once its single run has succeeded; a
 *  failed one-off (or a run that never started) is left alone so it stays retryable. */
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
  // Leave it enabled and scheduled: it stays visible in the activity feed as
  // a failed run, and the user can rerun it or fix it rather than losing the
  // automation to a retiring bug they never see.
  log.warn(
    { automationId },
    "one-off automation run failed — not retiring it so it stays scheduled for a retry",
  );
}

async function schedule(automation: { id: string; schedule: string }): Promise<void> {
  // "0 6 * * *" should mean 6am in the user's timezone, not the server's.
  const timezone = (await getTimezoneSetting()) ?? undefined;
  // Second line of defense alongside the per-id serialization in
  // withScheduleLock below: if a task is already registered for this id,
  // destroy it before the map entry is overwritten, so a lost race can never
  // leave an untracked task still firing.
  const stale = tasks.get(automation.id);
  if (stale) void stale.destroy();
  const task = cron.schedule(
    automation.schedule,
    () => {
      // runAutomation records its own failures; this only catches the ones it
      // couldn't (a database write that failed on the way in or out).
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

// Serializes schedule-mutating operations per automation id: refreshSchedule
// and rescheduleAll's per-automation step both funnel through this queue so
// two concurrent callers for the same id (double-click save, or rescheduleAll
// racing an edit) can never interleave their unschedule/select/schedule
// steps — whichever runs second sees the first's result rather than
// clobbering the tasks map entry out from under it.
const scheduleJobs = new KeyedJobs();

/** Unschedule an automation, then reschedule it if its current row says it should run. */
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

/** (Re)register the cron job for an automation based on its current state. */
export async function refreshSchedule(automationId: string): Promise<void> {
  return scheduleJobs.enqueue(automationId, () => applySchedule(automationId));
}

/**
 * Rebuild every enabled automation's cron task against the current timezone
 * setting. node-cron bakes the timezone into a task at creation time (see
 * schedule() above), so a timezone change only takes effect once tasks are
 * recreated — call this after the timezone setting changes.
 */
export async function rescheduleAll(): Promise<void> {
  if (!schedulerStarted) return;
  const all = await db.select().from(schema.automations);
  for (const automation of all) {
    // Routed through the same per-id queue as refreshSchedule so this can't
    // interleave with a concurrent edit's own refreshSchedule call.
    await scheduleJobs.enqueue(automation.id, () => applySchedule(automation.id));
  }
}

/** Called once on boot: close out any run interrupted by the last restart, then schedule every enabled automation. */
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

  // Catch up on runs the machine slept through: node-cron only fires while the
  // process is alive, so any slot that elapsed while it was off never ran. Kept
  // off the boot critical path — the runs it starts record themselves.
  void runMissedAutomations().catch((error: unknown) =>
    log.error({ err: error }, "boot catch-up failed"),
  );
}

/** Destroy every cron task and re-latch; only startScheduler() re-arms scheduling. */
export function stopScheduler(): void {
  schedulerStarted = false;
  for (const task of tasks.values()) void task.destroy();
  tasks.clear();
}
