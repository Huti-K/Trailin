import { emitServerEvent, onServerEvent } from "../../events.js";
import { env } from "../../env.js";
import { activeModelConfigured } from "../../llm/registry.js";
import { moduleLogger } from "../../logger.js";
import { listAccounts } from "../../pipedream/connect.js";
import { errorMessage } from "../../util.js";
import { enrichThread, resolveEnrichModel } from "./enrichLLM.js";
import {
  findStaleCandidates,
  saveEnrichment,
  saveEnrichmentError,
  snapshotThread,
  storedInputHash,
  touchEnrichment,
} from "./enrichStore.js";

const log = moduleLogger("enrich");

/**
 * Drives the enrichment pipeline. Purely reactive: staleness only ever
 * arises from mirror changes, so cycles are triggered by the sync engine's
 * "mail" events (debounced — one sweep usually lands several pages), plus a
 * boot catch-up and a slow safety interval for backlogs that appeared while
 * the LLM was unconfigured. Cycles are single-flight; a trigger landing
 * mid-cycle queues exactly one follow-up rather than stacking.
 */

const DEBOUNCE_MS = 2_000;
const SAFETY_INTERVAL_MS = 10 * 60_000;

let debounce: NodeJS.Timeout | null = null;
let running = false;
let runAgain = false;

/** Account display names for the prompt's "owner" line; ids beat nothing. */
async function accountNames(): Promise<Map<string, string>> {
  try {
    return new Map((await listAccounts()).map((account) => [account.id, account.name]));
  } catch {
    return new Map();
  }
}

async function runCycle(): Promise<void> {
  if (running) {
    runAgain = true;
    return;
  }
  running = true;
  try {
    if (!(await activeModelConfigured())) {
      log.debug("skipped: no usable LLM credentials");
      return;
    }
    // Backoff for errored threads is enforced inside the query itself, so
    // every candidate returned here is genuinely due for (re)enrichment.
    const candidates = findStaleCandidates(env.enrich.batch);
    if (candidates.length === 0) return;

    const [names, model] = await Promise.all([accountNames(), resolveEnrichModel()]);
    let enriched = 0;
    let failed = 0;
    let untouched = 0;

    // Small worker pool: LLM calls dominate, so chunked Promise.all is enough.
    for (let i = 0; i < candidates.length; i += env.enrich.concurrency) {
      const chunk = candidates.slice(i, i + env.enrich.concurrency);
      await Promise.all(
        chunk.map(async (candidate) => {
          const snapshot = snapshotThread(candidate.threadId, candidate.accountId);
          if (!snapshot) return; // thread vanished; candidate query won't surface it again
          if (snapshot.inputHash === storedInputHash(candidate.threadId)) {
            // Content still valid (e.g. only an unread flip touched the
            // thread row) — refresh the timestamp, skip the LLM entirely.
            touchEnrichment(candidate.threadId, snapshot.takenAt);
            untouched++;
            return;
          }
          try {
            const result = await enrichThread(
              snapshot,
              names.get(candidate.accountId) ?? candidate.accountId,
              model,
            );
            saveEnrichment(snapshot, result, model.id);
            enriched++;
          } catch (error) {
            saveEnrichmentError(snapshot, errorMessage(error));
            failed++;
          }
        }),
      );
    }

    if (enriched > 0 || failed > 0) {
      log.info({ enriched, failed, untouched }, "enrichment cycle done");
      emitServerEvent("mail_state");
    }
    // A full batch means there's likely more backlog — keep draining.
    if (candidates.length === env.enrich.batch) runAgain = true;
  } catch (error) {
    log.warn({ err: error }, "enrichment cycle failed");
  } finally {
    running = false;
    if (runAgain) {
      runAgain = false;
      scheduleCycle();
    }
  }
}

function scheduleCycle(): void {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void runCycle();
  }, DEBOUNCE_MS);
  debounce.unref();
}

export function startEnrichment(): void {
  onServerEvent((event) => {
    if (event.topic === "mail") scheduleCycle();
  });
  // Boot catch-up (the debounce delay also lets the first sync pages land),
  // then the slow safety net — cycles with nothing stale are one cheap query.
  scheduleCycle();
  setInterval(scheduleCycle, SAFETY_INTERVAL_MS).unref();
}
