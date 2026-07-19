import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { env } from "../../core/env.js";
import { emitRunNotification, emitServerEvent } from "../../core/events.js";
import { moduleLogger } from "../../core/logger.js";
import { errorMessage } from "../../core/utils/util.js";
import { db, schema } from "../../db/index.js";
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

/**
 * Why a run started, beyond its schedule. Rendered into the run's opening
 * message, so the agent knows what the run concerns — the firing mechanisms
 * themselves (todo completion, mail probe, catch-up) carry no other context
 * into the session.
 */
export type RunTrigger =
  | { kind: "todo"; todoId: string; title: string }
  | { kind: "mail"; accountNames: string[] }
  | { kind: "catchUp"; dueAt: string };

export async function executeAutomationRun(
  automationId: string,
  opts: { manual?: boolean; timeoutMs?: number; trigger?: RunTrigger } = {},
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
    // Anchors "since the last run" instructions; on a coalesced catch-up it
    // lets the agent widen a literal time window instead of losing the gap.
    const [lastSuccess] = await db
      .select({ finishedAt: schema.automationRuns.finishedAt })
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.automationId, automationId),
          eq(schema.automationRuns.status, "success"),
        ),
      )
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(1);
    const context = [
      lastSuccess?.finishedAt
        ? `The previous successful run finished at ${lastSuccess.finishedAt}.`
        : "This automation has no previous successful run.",
    ];
    const trigger = opts.trigger;
    if (trigger?.kind === "catchUp") {
      context.push(
        `This is a catch-up run: the scheduled slot due at ${trigger.dueAt} was missed because the app was not running, and earlier slots since the previous successful run may have been skipped too. Cover the entire period since that run, widening any time window in the instruction accordingly.`,
      );
    } else if (trigger?.kind === "todo") {
      context.push(
        `This run fired because the user completed the linked todo "${trigger.title}" (todo id ${trigger.todoId}). Whoever or whatever that todo names is the subject of this run.`,
      );
    } else if (trigger?.kind === "mail") {
      context.push(
        `This run was triggered by new inbound mail in: ${trigger.accountNames.join(", ")}. Start from that mailbox's newest messages instead of sweeping every account.`,
      );
    }
    const instructionMessage = `Scheduled automation "${automation.name}". ${context.join(" ")} Execute this instruction now and report the outcome:\n\n${automation.instruction}`;

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
