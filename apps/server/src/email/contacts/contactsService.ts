import type { Api, Model } from "@earendil-works/pi-ai";
import { env } from "../../env.js";
import { emitServerEvent, onServerEvent } from "../../events.js";
import { JobLoop, mapWithConcurrency } from "../../jobs.js";
import { activeModelConfigured } from "../../llm/registry.js";
import { moduleLogger } from "../../logger.js";
import { errorMessage } from "../../util.js";
import {
  buildContactSample,
  type ContactJudgment,
  type ContactSample,
  findStaleContacts,
  saveContactError,
  saveContactJudgment,
  touchContactEnrichment,
} from "./contactsEnrichStore.js";
import { judgeContact, resolveContactsModel } from "./contactsLLM.js";
import { deriveContacts } from "./contactsStore.js";

const log = moduleLogger("contacts");

/**
 * Drives the contacts pipeline: reactive to the mirror's "mail" events
 * (debounced), plus a boot catch-up and a slow safety interval, same shape
 * as email/enrich/enrichService.ts. Each cycle first re-derives every
 * contact's aggregates (cheap, no LLM), then judges whatever that left
 * stale, up to one batch. The JobLoop keeps cycles single-flight and
 * coalesces triggers that land mid-cycle.
 */

const DEBOUNCE_MS = 2_000;
const SAFETY_INTERVAL_MS = 10 * 60_000;

export interface ContactsCycleResult {
  /** Addresses whose aggregate changed this cycle. */
  derived: number;
  enriched: number;
  failed: number;
  /** Stale-looking candidates whose recomputed hash actually still matched. */
  untouched: number;
}

/**
 * One cycle, with the LLM call injectable so tests can drive it with a fake
 * judge instead of a real model. Exported (unlike enrichService's runCycle)
 * specifically for that seam.
 */
export async function runContactsCycle(
  judge: (sample: ContactSample, model: Model<Api>) => Promise<ContactJudgment> = judgeContact,
): Promise<ContactsCycleResult> {
  const derived = deriveContacts();
  let enriched = 0;
  let failed = 0;
  let untouched = 0;
  let candidateCount = 0;

  if (await activeModelConfigured()) {
    const candidates = findStaleContacts(env.contacts.batch);
    candidateCount = candidates.length;
    if (candidates.length > 0) {
      const model = await resolveContactsModel();
      await mapWithConcurrency(candidates, env.contacts.concurrency, async (candidate) => {
        const sample = buildContactSample(candidate.address);
        if (!sample) return; // contact vanished; candidate query won't surface it again
        if (sample.inputHash === candidate.inputHash) {
          // Content still valid (e.g. only the aggregate's updated_at moved)
          // — refresh the timestamp, skip the LLM entirely.
          touchContactEnrichment(candidate.address);
          untouched++;
          return;
        }
        try {
          const judgment = await judge(sample, model);
          saveContactJudgment(candidate.address, sample.inputHash, judgment, model.id);
          enriched++;
        } catch (error) {
          saveContactError(candidate.address, sample.inputHash, errorMessage(error));
          failed++;
        }
      });
    }
  } else {
    log.debug("contact judgments skipped: no usable LLM credentials");
  }

  if (derived > 0 || enriched > 0 || failed > 0) {
    log.info({ derived, enriched, failed, untouched }, "contacts cycle done");
    emitServerEvent("contacts");
  }
  // A full batch means there's likely more backlog — keep draining.
  if (candidateCount > 0 && candidateCount === env.contacts.batch) loop.trigger();
  return { derived, enriched, failed, untouched };
}

const loop = new JobLoop({
  name: "contacts",
  run: () => runContactsCycle().then(() => undefined),
  intervalMs: SAFETY_INTERVAL_MS,
  debounceMs: DEBOUNCE_MS,
});

let unsubscribe: (() => void) | null = null;

export function startContacts(): void {
  if (unsubscribe) return;
  unsubscribe = onServerEvent((event) => {
    if (event.topic === "mail") loop.trigger();
  });
  // start() fires a boot catch-up (the debounce delay also lets the first
  // sync pages land), then the slow safety net keeps draining backlogs.
  loop.start();
}

/** Detach from "mail" events and cancel pending cycles; one already running finishes on its own. */
export function stopContacts(): void {
  unsubscribe?.();
  unsubscribe = null;
  loop.stop();
}
