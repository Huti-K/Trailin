import type { ConnectedAccount } from "@trailin/shared";
import { resolveCheapModel } from "../../agent/llm/registry.js";
import { emitServerEvent } from "../../core/events.js";
import { moduleLogger } from "../../core/logger.js";
import {
  getLatestDraftBody,
  listOpenDraftSnapshots,
  markDraftStatus,
  type OpenDraftSnapshot,
} from "../../db/draftStore.js";
import { listAccounts } from "../../integrations/pipedream/connect.js";
import {
  getMailReadProvider,
  type MailReadProvider,
  type SentMessage,
} from "../read/readProviders.js";
import { normalizeAddressSet, normalizeSubject, sameAddressSet } from "./addressSubject.js";
import { resolveTiebreak } from "./matchLLM.js";

const log = moduleLogger("learn-match");

/** Standalone drafts match sent mail only within this window of creation; also the sweep's anchor floor (see sentSinceAnchor). */
const STANDALONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The draft-vs-sent matcher. Candidates come live from each account's
 * MailReadProvider (one listSentSince per account, anchored at its oldest open
 * draft). Deterministic rules, in order:
 *  - Reply drafts (snapshot has a threadId): the earliest candidate sharing
 *    that provider thread id, no LLM.
 *  - Standalone drafts: candidates whose recipient set and prefix-stripped
 *    subject match, within STANDALONE_WINDOW_MS. Exactly one is the match; zero
 *    leaves it open; more than one falls to the tiebreak seam.
 */

export type TiebreakFn = (input: {
  latestBody: string;
  candidates: Array<{ providerMessageId: string; body: string }>;
}) => Promise<string | null>;

export interface MatchSweepDeps {
  tiebreak?: TiebreakFn;
  listAccounts?: () => Promise<ConnectedAccount[]>;
  readerFor?: (app: string) => MailReadProvider | null;
}

/** May throw (unconfigured model, network, timeout, malformed report); the call site treats any failure as an explicit "none". */
async function defaultTiebreak(input: {
  latestBody: string;
  candidates: Array<{ providerMessageId: string; body: string }>;
}): Promise<string | null> {
  const model = await resolveCheapModel();
  return resolveTiebreak(input.latestBody, input.candidates, model);
}

/** The earliest candidate sharing the thread, or null; relies on listSentSince's ascending order. */
function threadMatch(candidates: SentMessage[], threadId: string): SentMessage | null {
  return candidates.find((candidate) => candidate.providerThreadId === threadId) ?? null;
}

function standaloneMatches(
  candidates: SentMessage[],
  draft: { to: string[]; subject: string; createdAt: string },
): SentMessage[] {
  const wantAddrs = normalizeAddressSet(draft.to);
  const wantSubject = normalizeSubject(draft.subject);
  const deadline = new Date(draft.createdAt).getTime() + STANDALONE_WINDOW_MS;
  return candidates.filter((candidate) => {
    if (new Date(candidate.date).getTime() > deadline) return false;
    if (normalizeSubject(candidate.subject) !== wantSubject) return false;
    return sameAddressSet(normalizeAddressSet(candidate.to), wantAddrs);
  });
}

/** The listSentSince anchor: oldest createdAt, clamped to STANDALONE_WINDOW_MS ago, so a stale draft can't drag the anchor back and spend listSentSince's cap on unmatchable mail. */
function sentSinceAnchor(drafts: OpenDraftSnapshot[]): string {
  const oldest = drafts.reduce(
    (min, draft) => (draft.createdAt < min ? draft.createdAt : min),
    drafts[0]?.createdAt ?? new Date().toISOString(),
  );
  const floor = new Date(Date.now() - STANDALONE_WINDOW_MS).toISOString();
  return oldest > floor ? oldest : floor;
}

async function matchDraft(
  draft: OpenDraftSnapshot,
  candidates: SentMessage[],
  tiebreak: TiebreakFn,
): Promise<boolean> {
  if (candidates.length === 0) return false;

  if (draft.threadId) {
    const hit = threadMatch(candidates, draft.threadId);
    if (!hit) return false;
    await markDraftStatus(draft.accountId, draft.providerDraftId, "sent", hit.providerMessageId);
    return true;
  }

  const hits = standaloneMatches(candidates, draft);
  if (hits.length === 0) return false;

  if (hits.length === 1 && hits[0]) {
    await markDraftStatus(
      draft.accountId,
      draft.providerDraftId,
      "sent",
      hits[0].providerMessageId,
    );
    return true;
  }

  // Ambiguous: several sends share recipients and subject. No match beats a wrong one, so any non-confident tiebreak (including it failing) leaves the draft open and never aborts the sweep.
  const latestBody = await getLatestDraftBody(draft.accountId, draft.providerDraftId);
  if (!latestBody) return false;
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
    return false;
  }
  if (!matchedId) return false;
  const hit = hits.find((candidate) => candidate.providerMessageId === matchedId);
  if (!hit) return false; // the model named an id outside the candidate set — treat as no match
  await markDraftStatus(draft.accountId, draft.providerDraftId, "sent", hit.providerMessageId);
  return true;
}

export interface MatchSweepResult {
  matched: number;
}

export async function runMatchSweep(deps: MatchSweepDeps = {}): Promise<MatchSweepResult> {
  const tiebreak = deps.tiebreak ?? defaultTiebreak;
  const readerFor = deps.readerFor ?? getMailReadProvider;

  const openDrafts = await listOpenDraftSnapshots();
  if (openDrafts.length === 0) return { matched: 0 };

  const byAccount = new Map<string, OpenDraftSnapshot[]>();
  for (const draft of openDrafts) {
    const bucket = byAccount.get(draft.accountId) ?? [];
    bucket.push(draft);
    byAccount.set(draft.accountId, bucket);
  }

  const accounts = await (deps.listAccounts ?? listAccounts)();
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  let matched = 0;
  for (const [accountId, drafts] of byAccount) {
    const account = accountById.get(accountId);
    if (!account) {
      log.debug({ accountId }, "open drafts for a disconnected account — skipping");
      continue;
    }
    const provider = readerFor(account.app);
    if (!provider) {
      log.debug({ accountId, app: account.app }, "no mail read driver — skipping match sweep");
      continue;
    }

    let candidates: SentMessage[];
    try {
      candidates = await provider.listSentSince(account, sentSinceAnchor(drafts));
    } catch (error) {
      log.warn(
        { err: error, accountId, app: account.app },
        "sent-mail fetch failed — skipping this account until the next sweep",
      );
      continue;
    }

    for (const draft of drafts) {
      const afterCreation = candidates.filter((candidate) => candidate.date > draft.createdAt);
      if (await matchDraft(draft, afterCreation, tiebreak)) matched++;
    }
  }

  if (matched > 0) {
    log.info({ matched }, "draft-vs-sent match sweep done");
    emitServerEvent("drafts");
  }
  return { matched };
}
