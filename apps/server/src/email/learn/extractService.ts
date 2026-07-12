import cron, { type ScheduledTask } from "node-cron";
import { getTimezoneSetting } from "../../db/settings.js";
import { moduleLogger } from "../../logger.js";
import { runExtractionSweep } from "./extractor.js";

const log = moduleLogger("learn-extract");

/**
 * Schedules the nightly extraction sweep (extractor.ts) at 03:00 in the
 * user's configured timezone (falling back to the server's local time when
 * none is set) — same node-cron usage as automations/scheduler.ts's
 * schedule(), a single fixed task rather than a user-configurable one. A
 * catch-up sweep also runs once at boot so a pair that became learnable
 * while the process was down isn't stuck waiting for the next 03:00.
 */

const NIGHTLY_CRON = "0 3 * * *";

let task: ScheduledTask | null = null;

function runSweep(reason: "boot" | "scheduled"): void {
  runExtractionSweep().catch((error: unknown) => {
    log.warn({ err: error, reason }, "nightly learning sweep failed to run");
  });
}

export async function startNightlyLearning(): Promise<void> {
  if (task) return;
  const timezone = (await getTimezoneSetting()) ?? undefined;
  task = cron.schedule(
    NIGHTLY_CRON,
    () => runSweep("scheduled"),
    timezone ? { timezone } : undefined,
  );
  runSweep("boot");
}

/** Destroy the nightly cron task; a sweep already running finishes on its own. */
export function stopNightlyLearning(): void {
  if (task) {
    void task.destroy();
    task = null;
  }
}
