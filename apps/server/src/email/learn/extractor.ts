import type { ConnectedAccount } from "@trailin/shared";
import { fetchAccountNameMap } from "../../agent/accounts.js";
import { resolveCheapModel } from "../../agent/llm/registry.js";
import { moduleLogger } from "../../core/logger.js";
import { errorMessage } from "../../core/utils/util.js";
import {
  getLatestAgentDraftBody,
  listUnlearnedSentDrafts,
  markDraftLearned,
} from "../../db/draftStore.js";
import { listAccounts } from "../../integrations/pipedream/connect.js";
import { collapseWhitespace } from "../../search/snippets.js";
import { createMemory } from "../../storage/memories/store.js";
import { getMailReadProvider, type MailReadProvider } from "../read/readProviders.js";
import { extractLessons } from "./extractLLM.js";

const log = moduleLogger("learn-extract");

/** Pairs per account per LLM call; any excess waits for the next sweep. */
const MAX_PAIRS_PER_CALL = 10;

interface PendingPair {
  providerDraftId: string;
  draftBody: string;
  sentBody: string;
}

export type ExtractFn = (input: {
  pairs: Array<{ draftBody: string; sentBody: string }>;
  accountName: string;
}) => Promise<string[]>;

async function defaultExtract(input: {
  pairs: Array<{ draftBody: string; sentBody: string }>;
  accountName: string;
}): Promise<string[]> {
  const model = await resolveCheapModel();
  return extractLessons(input.pairs, input.accountName, model);
}

export interface ExtractSweepDeps {
  extract?: ExtractFn;
  listAccounts?: () => Promise<ConnectedAccount[]>;
  readerFor?: (app: string) => MailReadProvider | null;
}

export interface ExtractSweepResult {
  /** Sent-but-unlearned drafts pending when the sweep started. */
  pending: number;
  /** Pairs stamped learned without a lesson: the draft was sent unchanged. */
  identical: number;
  /** Edited pairs consumed by extraction this sweep. */
  learned: number;
  /** Style memories created from those pairs. */
  lessons: number;
}

/**
 * The nightly extraction pass: each sent-but-unlearned snapshot is diffed
 * (whitespace-normalized) against its own latest agent-authored version. An
 * identical pair needed no lesson and is stamped directly; the rest are batched
 * per account (at most MAX_PAIRS_PER_CALL) into one LLM call whose directives
 * become account memories. Unresolvable pairs and any account whose LLM call
 * fails stay unstamped for a later night: dropping a lesson is fine, learning
 * the wrong one is not.
 */
export async function runExtractionSweep(deps: ExtractSweepDeps = {}): Promise<ExtractSweepResult> {
  const extract = deps.extract ?? defaultExtract;
  const readerFor = deps.readerFor ?? getMailReadProvider;

  const sentDrafts = await listUnlearnedSentDrafts();
  if (sentDrafts.length === 0) return { pending: 0, identical: 0, learned: 0, lessons: 0 };

  const accounts = await (deps.listAccounts ?? listAccounts)();
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const pendingByAccount = new Map<string, PendingPair[]>();
  let identical = 0;

  for (const draft of sentDrafts) {
    const account = accountById.get(draft.accountId);
    if (!account) continue; // disconnected — stays pending, recovers on reconnect
    const provider = readerFor(account.app);
    if (!provider) continue; // no read driver for this app — stays pending

    let sentBody: string | null;
    try {
      sentBody = await provider.getMessageBody(account, draft.sentMessageId);
    } catch (error) {
      log.warn(
        { err: errorMessage(error), accountId: draft.accountId },
        "sent-body fetch failed — pair stays pending for the next sweep",
      );
      continue;
    }
    if (sentBody === null) continue; // message gone at the provider — wait for a later night

    const draftBody = await getLatestAgentDraftBody(draft.accountId, draft.providerDraftId);
    if (draftBody === null) continue; // snapshot vanished or has no agent-authored version

    const strippedDraft = collapseWhitespace(draftBody);
    const strippedSent = collapseWhitespace(sentBody);
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
          // Rejected by memory's own limits (over-length, "memory is full"); skip this directive, not the batch.
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
  return { pending: sentDrafts.length, identical, learned, lessons };
}
