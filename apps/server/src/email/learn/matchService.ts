import { onServerEvent } from "../../events.js";
import { JobLoop } from "../../jobs.js";
import { runMatchSweep } from "./matcher.js";

/**
 * Drives the draft-vs-sent matcher. Purely reactive, same shape as thread
 * enrichment (email/enrich/enrichService.ts): a draft can only resolve when
 * new mail lands, so cycles are triggered by the sync engine's "mail" event
 * (debounced — one sweep usually lands several pages), plus a boot catch-up
 * and a slow safety interval for backlogs left over from a quiet mailbox.
 * The JobLoop keeps cycles single-flight and coalesces triggers that land
 * mid-cycle.
 */

const DEBOUNCE_MS = 2_000;
const SAFETY_INTERVAL_MS = 10 * 60_000;

const loop = new JobLoop({
  name: "learn-match",
  run: () => runMatchSweep(),
  intervalMs: SAFETY_INTERVAL_MS,
  debounceMs: DEBOUNCE_MS,
});

let unsubscribe: (() => void) | null = null;

export function startDraftMatching(): void {
  if (unsubscribe) return;
  unsubscribe = onServerEvent((event) => {
    if (event.topic === "mail") loop.trigger();
  });
  // start() fires a boot catch-up (the debounce delay also lets the first
  // sync pages land), then the slow safety net keeps draining backlogs.
  loop.start();
}

/** Detach from "mail" events and cancel pending cycles; one already running finishes on its own. */
export function stopDraftMatching(): void {
  unsubscribe?.();
  unsubscribe = null;
  loop.stop();
}
