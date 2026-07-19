import { moduleLogger } from "../../core/logger.js";
import { JobLoop, NightlyJob } from "../../core/utils/jobs.js";
import { errorMessage } from "../../core/utils/util.js";
import { recordLearnRun } from "../../db/learnRuns.js";
import { getTimezoneSetting } from "../../db/settings.js";
import { runExtractionSweep } from "./extractor.js";
import { runMatchSweep } from "./matcher.js";

const log = moduleLogger("learn");

/**
 * Lifecycle of the learning subsystem's two loops. The match loop runs the
 * matcher on a fixed interval; the nightly sweep runs at 03:00 in the user's
 * timezone (server local when unset), each preceded by a boot catch-up run.
 * A full sweep runs the matcher BEFORE extraction: extraction only sees pairs
 * the matcher has resolved, so a same-day send needn't wait on the match loop's
 * slower cadence.
 */

const MATCH_INTERVAL_MS = 30 * 60_000;
const NIGHTLY_CRON = "0 3 * * *";

/** One full sweep (match, then extract), recorded whatever the outcome. Never throws. */
export async function runLearningSweep(reason: "boot" | "scheduled"): Promise<void> {
  const startedAt = new Date().toISOString();
  let matched = 0;
  try {
    matched = (await runMatchSweep()).matched;
    const extracted = await runExtractionSweep();
    await recordLearnRun({
      reason,
      status: "ok",
      matched,
      ...extracted,
      error: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.warn({ err: error, reason }, "learning sweep failed to run");
    await recordLearnRun({
      reason,
      status: "error",
      matched,
      pending: 0,
      identical: 0,
      learned: 0,
      lessons: 0,
      error: errorMessage(error),
      startedAt,
      finishedAt: new Date().toISOString(),
    }).catch((recordError: unknown) => {
      log.warn({ err: recordError }, "failed to record the learning sweep's failure");
    });
  }
}

const matchLoop = new JobLoop({
  name: "learn-match",
  run: async () => {
    await runMatchSweep();
  },
  intervalMs: MATCH_INTERVAL_MS,
});

const nightly = new NightlyJob({
  name: "learn-extract",
  cron: NIGHTLY_CRON,
  run: runLearningSweep,
});

export async function startLearning(): Promise<void> {
  matchLoop.start();
  nightly.start((await getTimezoneSetting()) ?? undefined);
}

/** Rebuild the nightly cron against the current timezone; a no-op while stopped. The interval-based match loop needs no rebuild. */
export async function rescheduleNightlyLearn(): Promise<void> {
  nightly.reschedule((await getTimezoneSetting()) ?? undefined);
}

/** Stop both loops; a sweep already running finishes on its own. */
export function stopLearning(): void {
  matchLoop.stop();
  nightly.stop();
}

/** When the nightly sweep fires next; null while not scheduled. */
export function nextLearnRunAt(): string | null {
  return nightly.nextRunAt();
}
