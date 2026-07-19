import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../core/env.js";
import { emitRunNotification, emitServerEvent } from "../core/events.js";
import { moduleLogger } from "../core/logger.js";
import { errorMessage } from "../core/utils/util.js";
import { db, schema } from "../db/index.js";
import { getTurnRunner } from "./turnRunner.js";

const log = moduleLogger("runRecorder");

/** A bad AUTOMATION_RUN_TIMEOUT_MS falls back to the default instead of aborting every run instantly. */
const DEFAULT_TIMEOUT_MS =
  Number.isFinite(env.automationRunTimeoutMs) && env.automationRunTimeoutMs > 0
    ? env.automationRunTimeoutMs
    : 300_000;

const NOTIFICATION_SUMMARY_CHARS = 140;

function notificationSummary(result: string): string {
  const firstLine = result.split("\n", 1)[0] ?? "";
  return firstLine.slice(0, NOTIFICATION_SUMMARY_CHARS);
}

export interface AutomationRunResult {
  started: boolean;
  succeeded: boolean;
  /** Echoed so scheduler.ts can retire a one-off run without re-querying. Set when started is true. */
  schedule?: string;
}

export async function executeAutomationRun(
  automationId: string,
  opts: { manual?: boolean; timeoutMs?: number } = {},
): Promise<AutomationRunResult> {
  const [automation] = await db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.id, automationId));
  // A ghost task (leaked by a schedule/unschedule race, or fired between
  // disabling and unschedule()) does not run: re-checking the row rather than
  // trusting the state when the task was registered. Manual "Run now" bypasses
  // the enabled gate; pausing stops the schedule, not the user.
  if (!automation || (!automation.enabled && !opts.manual)) {
    log.warn(
      { automationId, found: Boolean(automation) },
      "skipping run — automation is missing or disabled",
    );
    return { started: false, succeeded: false };
  }

  const runId = randomUUID();
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
  // Bound the whole turn: a stuck model or MCP call would otherwise keep the
  // run alive forever, and on a repeating schedule scheduler.ts's overlap guard
  // would then wedge the automation permanently.
  const signal = AbortSignal.timeout(timeoutMs);

  // Gates scheduler.ts's one-off retirement: a one-time schedule whose only run
  // errored is not silently disabled with zero successful executions.
  let succeeded = false;
  try {
    const instructionMessage = `Scheduled automation "${automation.name}". Execute this instruction now and report the outcome:\n\n${automation.instruction}`;

    // The run id is the conversation id, so drafts created by this run link back
    // to its transcript. The turn runner writes the conversation and message
    // rows; this run row tracks only status, timing, and result.
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
    // The log keeps the stack, the only place it survives for an unattended run.
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
 * Called once on boot: a run still "running" belongs to a process that died
 * mid-run (runs live only in this process) and would spin in the UI forever.
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
