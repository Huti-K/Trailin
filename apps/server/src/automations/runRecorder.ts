import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { emitRunNotification, emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import { errorMessage } from "../utils/util.js";
import { getTurnRunner } from "./turnRunner.js";

const log = moduleLogger("runRecorder");

/** Sanitized run deadline: a bad AUTOMATION_RUN_TIMEOUT_MS must not abort every run instantly. */
const DEFAULT_TIMEOUT_MS =
  Number.isFinite(env.automationRunTimeoutMs) && env.automationRunTimeoutMs > 0
    ? env.automationRunTimeoutMs
    : 300_000;

/** Cap on the notification body: enough for a one-line result, short enough for the OS banner. */
const NOTIFICATION_SUMMARY_CHARS = 140;

/** First line of a run's result text, truncated to the notification-body cap. */
function notificationSummary(result: string): string {
  const firstLine = result.split("\n", 1)[0] ?? "";
  return firstLine.slice(0, NOTIFICATION_SUMMARY_CHARS);
}

export interface AutomationRunResult {
  /**
   * False when the automation row is missing, or disabled and this wasn't a
   * manual "Run now" — no automation_runs row was created and no
   * Conversation was touched.
   */
  started: boolean;
  succeeded: boolean;
  /**
   * The automation's schedule string, echoed back so a caller can decide
   * one-off retirement (automations/scheduler.ts's isOneOffSchedule)
   * without a second lookup. Present whenever `started` is true.
   */
  schedule?: string;
}

/**
 * Run one automation now: inserts the automation_runs row, mirrors the run
 * into its own Conversation (id = the run id, via the registered turn runner
 * and db/conversationStore.ts), and writes the terminal status — success, error,
 * or a timeout — back onto the run row. The structural twin of
 * turnRecorder.ts's beginTurn for Runs instead of Turns: this is the only
 * place an automation_runs row is written, and automations/scheduler.ts is
 * its only caller, supplying the cron/manual transport and the overlap
 * guard around it.
 */
export async function executeAutomationRun(
  automationId: string,
  opts: { manual?: boolean; timeoutMs?: number } = {},
): Promise<AutomationRunResult> {
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
    return { started: false, succeeded: false };
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

  const timeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  // Bound the whole agent turn: a stuck model or MCP call otherwise keeps the
  // run (and its MCP sessions) alive forever, and on a repeating schedule the
  // overlap guard in scheduler.ts would then wedge the automation permanently.
  const signal = AbortSignal.timeout(timeoutMs);

  // Gates the one-off retirement scheduler.ts drives off this result: a
  // one-time schedule whose only run errored or timed out must not be
  // silently disabled with zero successful executions — the user would have
  // no way to know it never ran.
  let succeeded = false;
  try {
    const instructionMessage = `Scheduled automation "${automation.name}". Execute this instruction now and report the outcome:\n\n${automation.instruction}`;

    // The run id is the conversation id, so drafts created by this run link
    // back to the run's transcript and its cards render when it's reopened.
    // The turn runner (agent/turnRecorder.ts behind turnRunner.ts's registry)
    // ensures the parent Conversation row and writes the turn's
    // user/assistant rows itself — including its own transcript-capping row
    // on failure or cancellation — so this run row only tracks the run's own
    // status, timing and, on success, its result.
    const { text, cardsJson } = await getTurnRunner()({
      runId,
      prompt: instructionMessage,
      title: `Run: ${automation.name}`,
      signal,
      log: runLog,
    });

    await db
      .update(schema.automationRuns)
      .set({
        status: "success",
        result: text,
        cards: cardsJson,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.automationRuns.id, runId));
    emitServerEvent("runs");
    if (automation.notifyOnCompletion) {
      emitRunNotification({
        runId,
        automationId,
        automationName: automation.name,
        status: "success",
        summary: notificationSummary(text),
      });
    }
    runLog.info({ durationMs: Date.now() - startedAt }, "automation run finished");
    succeeded = true;
  } catch (error) {
    // The run's row records the message for the UI; the log keeps the stack,
    // which is the only place it survives for an unattended run.
    const timedOut = signal.aborted;
    const message = timedOut
      ? `Run stopped after exceeding the ${Math.round(timeoutMs / 1000)}s time limit.`
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
    if (automation.notifyOnCompletion) {
      emitRunNotification({
        runId,
        automationId,
        automationName: automation.name,
        status: "error",
        summary: notificationSummary(message),
      });
    }
  }

  return { started: true, succeeded, schedule: automation.schedule };
}

/**
 * Called once on boot, before any cron task is (re)registered: runs only
 * live inside this process, so an automation_runs row still "running" at
 * boot belongs to a process that died mid-run and would spin in the UI
 * forever. Mirrors turnRecorder.ts's recoverInterruptedTurns for the Run
 * side of the same crash.
 */
export async function sweepOrphanedRuns(): Promise<void> {
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
}
