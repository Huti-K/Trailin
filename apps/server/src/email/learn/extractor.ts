import { fetchAccountNameMap } from "../../agent/accounts.js";
import {
  getLatestAgentDraftBody,
  listUnlearnedSentDrafts,
  markDraftLearned,
} from "../../db/draftStore.js";
import { createMemory } from "../../db/memories.js";
import { moduleLogger } from "../../logger.js";
import { errorMessage } from "../../util.js";
import { extractLessons } from "./extractLLM.js";
import { resolveLearnModel } from "./learnModel.js";
import { findSentMessageBody } from "./learnStore.js";

const log = moduleLogger("learn-extract");

/** One account's LLM call covers at most this many pending pairs a night; any excess waits for the next sweep. */
const MAX_PAIRS_PER_CALL = 10;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whitespace-normalized body with the account's compose-time signature
 * stripped off the end, when it's present verbatim (agent-authored bodies
 * always have it; a provider round-trip on the sent copy sometimes doesn't
 * preserve it byte-for-byte, in which case the body is left as-is rather
 * than mis-stripped).
 */
function stripSignature(body: string, signature: string | null): string {
  const normalized = normalizeWhitespace(body);
  const normalizedSignature = signature ? normalizeWhitespace(signature) : "";
  if (!normalizedSignature || !normalized.endsWith(normalizedSignature)) return normalized;
  return normalizeWhitespace(normalized.slice(0, normalized.length - normalizedSignature.length));
}

interface PendingPair {
  providerDraftId: string;
  draftBody: string;
  sentBody: string;
}

export type ExtractFn = (input: {
  pairs: Array<{ draftBody: string; sentBody: string }>;
  accountName: string;
}) => Promise<string[]>;

/** Real extraction: resolves a cheap model and asks it for style lessons over one account's pairs. */
async function defaultExtract(input: {
  pairs: Array<{ draftBody: string; sentBody: string }>;
  accountName: string;
}): Promise<string[]> {
  const model = await resolveLearnModel();
  return extractLessons(input.pairs, input.accountName, model);
}

/**
 * One sweep's worth of the nightly extraction pass: every sent-but-unlearned
 * agent_drafts snapshot whose sent message the mirror can resolve is diffed
 * against its own latest agent-authored version, signature stripped from
 * both sides. A pair identical after stripping needed no lesson and is
 * stamped learned_at directly; every other pair is batched per account (at
 * most MAX_PAIRS_PER_CALL) into one LLM call whose reported directives
 * become account-scoped memories. Unresolvable pairs (mirror hasn't synced
 * the sent message yet) and any account whose LLM call fails are left
 * unstamped for a later night — dropping a lesson is fine, learning the
 * wrong one is not.
 */
export async function runExtractionSweep(extract: ExtractFn = defaultExtract): Promise<void> {
  const sentDrafts = await listUnlearnedSentDrafts();
  if (sentDrafts.length === 0) return;

  const pendingByAccount = new Map<string, PendingPair[]>();
  let identical = 0;

  for (const draft of sentDrafts) {
    const sentBody = findSentMessageBody(draft.accountId, draft.sentMessageId);
    if (sentBody === null) continue; // not yet mirrored — wait for a later night

    const draftBody = await getLatestAgentDraftBody(draft.accountId, draft.providerDraftId);
    if (draftBody === null) continue; // snapshot vanished or has no agent-authored version

    const strippedDraft = stripSignature(draftBody, draft.signature);
    const strippedSent = stripSignature(sentBody, draft.signature);
    if (strippedDraft === strippedSent) {
      await markDraftLearned(draft.accountId, draft.providerDraftId);
      identical++;
      continue;
    }

    const bucket = pendingByAccount.get(draft.accountId) ?? [];
    bucket.push({
      providerDraftId: draft.providerDraftId,
      draftBody: strippedDraft,
      sentBody: strippedSent,
    });
    pendingByAccount.set(draft.accountId, bucket);
  }

  let learned = 0;
  let lessons = 0;

  const names = pendingByAccount.size > 0 ? await fetchAccountNameMap() : new Map<string, string>();
  for (const [accountId, allPairs] of pendingByAccount) {
    const pairs = allPairs.slice(0, MAX_PAIRS_PER_CALL);
    try {
      const directives = await extract({
        pairs: pairs.map((pair) => ({ draftBody: pair.draftBody, sentBody: pair.sentBody })),
        accountName: names.get(accountId) ?? accountId,
      });
      for (const directive of directives) {
        try {
          await createMemory(directive, "agent", accountId);
          lessons++;
        } catch (error) {
          // Over-length or otherwise rejected by memory's own limits (including
          // "memory is full") — skip this one directive, not the whole batch.
          log.warn(
            { err: errorMessage(error), accountId },
            "style directive rejected by memory store",
          );
        }
      }
      for (const pair of pairs) {
        await markDraftLearned(accountId, pair.providerDraftId);
        learned++;
      }
    } catch (error) {
      log.warn(
        { err: errorMessage(error), accountId, pending: pairs.length },
        "nightly extraction failed for this account — pairs stay pending for the next sweep",
      );
    }
  }

  if (identical > 0 || learned > 0) {
    log.info({ identical, learned, lessons }, "nightly learning sweep done");
  }
}
