import { randomUUID } from "node:crypto";
import cron, { type ScheduledTask } from "node-cron";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { beginTurn, serializeTurnCards } from "../agent/turnRecorder.js";
import { getTimezoneSetting } from "../db/settings.js";
import { env } from "../env.js";
import { emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import { errorMessage } from "../util.js";

const log = moduleLogger("scheduler");

const tasks = new Map<string, ScheduledTask>();

// Automations with a run currently executing, so a cron tick (or a "Run now"
// click) can't stack a second agent on top of one still working — on a tight
// schedule that piled up concurrent runs, each opening its own MCP sessions.
const runningAutomations = new Set<string>();

/** Sanitized run deadline: a bad AUTOMATION_RUN_TIMEOUT_MS must not abort every run instantly. */
const RUN_TIMEOUT_MS =
  Number.isFinite(env.automationRunTimeoutMs) && env.automationRunTimeoutMs > 0
    ? env.automationRunTimeoutMs
    : 300_000;

// Demo mode never calls startScheduler(), so nothing may create cron tasks
// behind its back — rescheduleAll() has to stay inert until boot scheduled.
let schedulerStarted = false;

export function isValidCron(expression: string): boolean {
  return cron.validate(expression);
}

/** Next scheduled fire time for an automation, or null when it isn't scheduled (disabled/invalid). */
export function getNextRunAt(automationId: string): string | null {
  const next = tasks.get(automationId)?.getNextRun();
  return next ? next.toISOString() : null;
}

/** True for the client's "specific date" schedule shape: a fixed day-of-month
 *  and month, matched on any weekday. Plain cron has no year field, so left
 *  alone this would recur annually — the caller disables the automation
 *  after this first *successful* run so it behaves as a one-time schedule.
 *  Nothing in the automation row or the API distinguishes this from a
 *  hand-written annual cron like "0 9 15 3 *" (checked apps/web/src and the
 *  automations schema/routes — no oneOff/type flag exists anywhere), so an
 *  annual cron that happens to match this shape is retired after its first
 *  run too. Accepted as the closest guess available without a schema change. */
function isOneOffSchedule(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, , dom, month, dow] = parts;
  return dom !== "*" && month !== "*" && dow === "*";
}

/** Execute one automation now (used by the scheduler and the "Run now" button).
 *  `manual` marks an explicit user-triggered run, which may run a paused
 *  automation; scheduled ticks never may. */
export async function runAutomation(
  automationId: string,
  opts: { manual?: boolean } = {},
): Promise<void> {
  // One run per automation at a time — a cron tick (or a second "Run now")
  // that lands while the previous run is still working is dropped, not stacked.
  if (runningAutomations.has(automationId)) {
    log.warn(
      { automationId },
      "skipping run — previous run of this automation is still in progress",
    );
    return;
  }
  runningAutomations.add(automationId);
  try {
    await executeAutomationRun(automationId, opts);
  } finally {
    runningAutomations.delete(automationId);
  }
}

async function executeAutomationRun(
  automationId: string,
  opts: { manual?: boolean } = {},
): Promise<void> {
  const [automation] = await db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.id, automationId));
  // A ghost task — one leaked by a lost schedule/unschedule race, or one that
  // fired between the automation being disabled and unschedule() running —
  // must not still execute. Re-check the current row rather than trusting
  // whatever state was true when the task was registered. A manual "Run now"
  // is exempt from the enabled gate: pausing stops the schedule, not the user.
  if (!automation || (!automation.enabled && !opts.manual)) {
    log.warn(
      { automationId, found: Boolean(automation) },
      "skipping run — automation is missing or disabled",
    );
    return;
  }

  const runId = randomUUID();
  // Nobody is watching a 06:00 briefing. Every line this run produces carries
  // the run id, so a failure can be traced back through the log afterwards.
  const runLog = log.child({ runId, automationId, automation: automation.name });
  const startedAt = Date.now();
  runLog.info("automation run started");

  await db.insert(schema.automationRuns).values({
    id: runId,
    automationId,
    status: "running",
    result: "",
    startedAt: new Date().toISOString(),
  });
  emitServerEvent("runs");

  // Bound the whole agent turn: a stuck model or MCP call otherwise keeps the
  // run (and its MCP sessions) alive forever, and on a repeating schedule the
  // overlap guard above would then wedge the automation permanently.
  const controller = new AbortController();
  const runTimeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

  // Gates the one-off retire below: a one-time schedule whose only run
  // errored or timed out must not be silently disabled with zero successful
  // executions — the user would have no way to know it never ran.
  let succeeded = false;
  try {
    // Create a conversation for the automation run
    await db.insert(schema.conversations).values({
      id: runId,
      title: `Run: ${automation.name}`,
      type: "automation",
      createdAt: new Date().toISOString(),
    });
    emitServerEvent("conversations");

    const instructionMessage = `Scheduled automation "${automation.name}". Execute this instruction now and report the outcome:\n\n${automation.instruction}`;

    // The run id is the conversation id, so drafts created by this run link
    // back to the run's transcript and its cards render when it's reopened.
    // The recorder writes the turn's user/assistant rows — including its own
    // transcript-capping row on failure or cancellation — so this run row
    // only tracks the run's own status, timing and, on success, its result.
    const turn = beginTurn(runId);
    const { text, cards } = await turn.run({
      prompt: instructionMessage,
      session: "ephemeral",
      signal: controller.signal,
      log: runLog,
    });

    await db
      .update(schema.automationRuns)
      .set({
        status: "success",
        result: text,
        cards: serializeTurnCards(cards),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.automationRuns.id, runId));
    emitServerEvent("runs");
    runLog.info({ durationMs: Date.now() - startedAt }, "automation run finished");
    succeeded = true;
  } catch (error) {
    // The run's row records the message for the UI; the log keeps the stack,
    // which is the only place it survives for an unattended run.
    const timedOut = controller.signal.aborted;
    const message = timedOut
      ? `Run stopped after exceeding the ${Math.round(RUN_TIMEOUT_MS / 1000)}s time limit.`
      : errorMessage(error);
    runLog.error(
      { err: error, timedOut, durationMs: Date.now() - startedAt },
      "automation run failed",
    );
    await db
      .update(schema.automationRuns)
      .set({
        status: "error",
        result: message,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.automationRuns.id, runId));
    emitServerEvent("runs");
  } finally {
    clearTimeout(runTimeout);
  }

  if (isOneOffSchedule(automation.schedule)) {
    if (succeeded) {
      await db
        .update(schema.automations)
        .set({ enabled: false })
        .where(eq(schema.automations.id, automationId));
      unschedule(automationId);
    } else {
      // Leave it enabled and scheduled: it stays visible in the activity
      // feed as a failed run, and the user can rerun it or fix it rather
      // than losing the automation to a retiring bug they never see.
      runLog.warn(
        { automationId },
        "one-off automation run failed — not retiring it so it stays scheduled for a retry",
      );
    }
  }
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

// Serializes schedule-mutating operations per automation id — mirrors
// FileCredentialStore.enqueue in auth/credentialStore.ts, keyed by id
// instead of a single instance-wide chain. refreshSchedule and
// rescheduleAll's per-automation step both funnel through this so two
// concurrent callers for the same id (double-click save, or rescheduleAll
// racing an edit) can never interleave their unschedule/select/schedule
// steps — whichever runs second sees the first's result rather than
// clobbering the tasks map entry out from under it.
const scheduleChains = new Map<string, Promise<unknown>>();

function withScheduleLock(automationId: string, fn: () => Promise<void>): Promise<void> {
  const prior = scheduleChains.get(automationId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  // Chain is always-resolving so one failed link never wedges later calls
  // for this id; the caller still observes `next`'s real rejection.
  scheduleChains.set(
    automationId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** (Re)register the cron job for an automation based on its current state. */
export async function refreshSchedule(automationId: string): Promise<void> {
  return withScheduleLock(automationId, async () => {
    unschedule(automationId);
    const [automation] = await db
      .select()
      .from(schema.automations)
      .where(eq(schema.automations.id, automationId));
    if (automation?.enabled && isValidCron(automation.schedule)) {
      await schedule(automation);
    }
  });
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
    // Routed through the same per-id lock as refreshSchedule so this can't
    // interleave with a concurrent edit's own refreshSchedule call.
    await withScheduleLock(automation.id, async () => {
      unschedule(automation.id);
      if (automation.enabled && isValidCron(automation.schedule)) {
        await schedule(automation);
      }
    });
  }
}

/** Called once on boot: schedule every enabled automation. */
export async function startScheduler(): Promise<void> {
  // Runs only live inside this process, so a row still "running" at boot
  // belongs to a process that died mid-run and would spin in the UI forever.
  const orphaned = await db
    .update(schema.automationRuns)
    .set({
      status: "error",
      result: "Interrupted by a server restart before the run could finish.",
      finishedAt: new Date().toISOString(),
    })
    .where(eq(schema.automationRuns.status, "running"))
    .returning({ id: schema.automationRuns.id });
  if (orphaned.length > 0) {
    log.warn({ count: orphaned.length }, "orphaned in-flight automation runs marked as error");
  }

  const all = await db.select().from(schema.automations);
  for (const automation of all) {
    if (automation.enabled && isValidCron(automation.schedule)) {
      await schedule(automation);
    }
  }
  schedulerStarted = true;
  log.info({ count: tasks.size }, "automations scheduled");
}
