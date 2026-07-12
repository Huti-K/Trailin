import {
  getLatestDraftBody,
  listOpenDraftSnapshots,
  markDraftStatus,
} from "../../db/draftStore.js";
import { emitServerEvent } from "../../events.js";
import { moduleLogger } from "../../logger.js";
import { normalizeAddressSet, normalizeSubject, sameAddressSet } from "./addressSubject.js";
import { resolveLearnModel } from "./learnModel.js";
import { findSentAfter, type SentCandidate } from "./learnStore.js";
import { resolveTiebreak } from "./matchLLM.js";

const log = moduleLogger("learn-match");

/** Standalone drafts only match sent mail within this window of their creation. */
const STANDALONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One sweep's worth of the draft-vs-sent matcher: for every open agent_drafts
 * snapshot, look for the mail it turned into.
 *
 * Deterministic rules, in order:
 *  - Reply drafts (snapshot has a threadId): any candidate sharing that
 *    provider_thread_id is the match — the earliest one after creation when
 *    several exist, no LLM involved.
 *  - Standalone drafts: candidates whose recipient set equals the snapshot's
 *    `to` set and whose subject matches ignoring reply prefixes, case, and
 *    whitespace, within STANDALONE_WINDOW_MS of creation. Exactly one such
 *    candidate is the match; zero leaves the draft open; more than one is
 *    genuinely ambiguous and falls to the tiebreak seam.
 *
 * A draft with zero candidates at all (nothing sent from the account since
 * it was created) is skipped without touching the match rules.
 */

export type TiebreakFn = (input: {
  latestBody: string;
  candidates: Array<{ providerMessageId: string; body: string }>;
}) => Promise<string | null>;

/** Real tiebreak: resolves a cheap model and asks it to pick the matching candidate. May throw
 *  (unconfigured model, network failure, timeout, a malformed report) — runMatchSweep's call site
 *  is what guarantees a failure here is treated exactly like an explicit "none". */
async function defaultTiebreak(input: {
  latestBody: string;
  candidates: Array<{ providerMessageId: string; body: string }>;
}): Promise<string | null> {
  const model = await resolveLearnModel();
  return resolveTiebreak(input.latestBody, input.candidates, model);
}

/** The earliest candidate in the same thread, or null when none share it. Relies on findSentAfter's ascending order. */
function threadMatch(candidates: SentCandidate[], threadId: string): SentCandidate | null {
  return candidates.find((candidate) => candidate.providerThreadId === threadId) ?? null;
}

/** Every candidate whose recipients and subject match the draft, within the standalone window. */
function standaloneMatches(
  candidates: SentCandidate[],
  draft: { to: string[]; subject: string; createdAt: string },
): SentCandidate[] {
  const wantAddrs = normalizeAddressSet(draft.to);
  const wantSubject = normalizeSubject(draft.subject);
  const deadline = new Date(draft.createdAt).getTime() + STANDALONE_WINDOW_MS;
  return candidates.filter((candidate) => {
    if (new Date(candidate.date).getTime() > deadline) return false;
    if (normalizeSubject(candidate.subject) !== wantSubject) return false;
    return sameAddressSet(normalizeAddressSet(candidate.to), wantAddrs);
  });
}

export async function runMatchSweep(tiebreak: TiebreakFn = defaultTiebreak): Promise<void> {
  const openDrafts = await listOpenDraftSnapshots();
  if (openDrafts.length === 0) return;

  let matched = 0;
  for (const draft of openDrafts) {
    const candidates = findSentAfter(draft.accountId, draft.createdAt);
    if (candidates.length === 0) continue;

    if (draft.threadId) {
      const hit = threadMatch(candidates, draft.threadId);
      if (hit) {
        await markDraftStatus(
          draft.accountId,
          draft.providerDraftId,
          "sent",
          hit.providerMessageId,
        );
        matched++;
      }
      continue;
    }

    const hits = standaloneMatches(candidates, draft);
    if (hits.length === 0) continue;

    if (hits.length === 1) {
      const hit = hits[0];
      if (hit) {
        await markDraftStatus(
          draft.accountId,
          draft.providerDraftId,
          "sent",
          hit.providerMessageId,
        );
        matched++;
      }
      continue;
    }

    // Genuinely ambiguous: several sends share recipients and subject within
    // the window. No match beats a wrong match, so anything but a confident
    // pick from the tiebreak — including the tiebreak itself failing — leaves
    // the draft open for a later sweep, and must not abort the rest of this
    // sweep's remaining drafts.
    const latestBody = await getLatestDraftBody(draft.accountId, draft.providerDraftId);
    if (!latestBody) continue;
    let matchedId: string | null;
    try {
      matchedId = await tiebreak({
        latestBody,
        candidates: hits.map((hit) => ({
          providerMessageId: hit.providerMessageId,
          body: hit.bodyText,
        })),
      });
    } catch (error) {
      log.warn(
        { err: error, accountId: draft.accountId, providerDraftId: draft.providerDraftId },
        "sent-mail tiebreak failed — leaving the draft open",
      );
      continue;
    }
    if (!matchedId) continue;
    const hit = hits.find((candidate) => candidate.providerMessageId === matchedId);
    if (!hit) continue; // the model named an id outside the candidate set — treat as no match
    await markDraftStatus(draft.accountId, draft.providerDraftId, "sent", hit.providerMessageId);
    matched++;
  }

  if (matched > 0) {
    log.info({ matched }, "draft-vs-sent match sweep done");
    emitServerEvent("drafts");
  }
}
