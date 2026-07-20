import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  type AccountVoice,
  type ConnectedAccount,
  EMAIL_APPS,
  MEMORY_MAX_LENGTH,
} from "@trailin/shared";
import { moduleLogger } from "../core/logger.js";
import { errorMessage } from "../core/utils/util.js";
import { getAccountVoices, patchAccountVoice } from "../db/settings.js";
import {
  deleteVoiceLearnRun,
  failInterruptedVoiceLearnRuns,
  finishVoiceLearnRun,
  listVoiceLearnRuns,
  markVoiceLearnRunning,
} from "../db/voiceRuns.js";
import { normalizeAddressSet } from "../email/learn/addressSubject.js";
import { getMailReadProvider, type SentMessage } from "../email/read/readProviders.js";
import { listAccounts } from "../integrations/pipedream/connect.js";
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from "../storage/memories/store.js";
import { activeModelConfigured } from "./llm/registry.js";
import { type ReportToolSpec, runReportPrompt } from "./oneShot.js";
import { appLanguageName } from "./prompt.js";
import { textResult, tool } from "./toolkit.js";

const log = moduleLogger("voiceLearn");

const SAMPLE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 40;
const MAX_SAMPLES = 15;
const MAX_BODY_CHARS = 2000;

/** Accounts with a learn in flight: one learn per account, across every entry point. */
const inFlight = new Set<string>();

/**
 * No usable sent mail in the sample window. recordedLearn treats it as a quiet
 * skip, not a failure: it deletes the attempt row (so Settings shows no error
 * and boot reconcile re-attempts the account later).
 */
class NoSentMailError extends Error {}

/**
 * The one recorded failure boot reconcile retries. An account connected before
 * a model was configured fails with this and would otherwise count as attempted
 * forever; reconcile only runs once a model exists, so the error is stale by
 * definition. Matched by exact message, so both sites must use this constant.
 */
const NO_MODEL_ERROR = "no LLM configured — sign in under Settings → AI";

/**
 * One learn per account at a time: a concurrent second is refused, since two
 * overlapping learns would race each other's memory writes. Every outcome is
 * recorded to db/voiceRuns.ts (a failed learn gets a retry button in Settings,
 * a success clears the error badge); NoSentMailError deletes the row instead.
 * Rethrows the learn's error after recording; the outcome writes are
 * best-effort.
 */
async function recordedLearn<T>(accountId: string, learn: () => Promise<T>): Promise<T> {
  if (inFlight.has(accountId)) {
    throw new Error("a voice learn for this account is already running — wait for it to finish");
  }
  inFlight.add(accountId);
  try {
    await markVoiceLearnRunning(accountId);
    const result = await learn();
    await finishVoiceLearnRun(accountId);
    return result;
  } catch (error) {
    if (error instanceof NoSentMailError) {
      await deleteVoiceLearnRun(accountId).catch((recordError: unknown) => {
        log.warn({ err: recordError, accountId }, "failed to clear the skipped voice learn's row");
      });
    } else {
      await finishVoiceLearnRun(accountId, errorMessage(error)).catch((recordError: unknown) => {
        log.warn({ err: recordError, accountId }, "failed to record the voice learn's outcome");
      });
    }
    throw error;
  } finally {
    inFlight.delete(accountId);
  }
}

function systemPromptFor(accountName: string, languageName: string): string {
  return `You are a writing-style analyst for Trailin, a personal email assistant. Your only job is
to study the user's OWN sent messages from the connected account ${accountName} — provided below in
the prompt — and report back their writing style, nothing else. Study how the user writes: greeting,
sign-off, tone, length, language(s). Write every directive in ${languageName}. When you are done,
call the report_style tool exactly once with your findings.`;
}

/**
 * Downselect for variety: newest first, one message per thread, preferring
 * unseen recipient sets, so the sample spans the user's range instead of one
 * thread.
 */
function sampleSentMessages(sent: SentMessage[]): SentMessage[] {
  const newestFirst = [...sent].reverse();
  const seenThreads = new Set<string>();
  const seenRecipients = new Set<string>();
  const distinct: SentMessage[] = [];
  const fallback: SentMessage[] = [];
  for (const message of newestFirst) {
    if (!message.bodyText.trim()) continue;
    if (seenThreads.has(message.providerThreadId)) continue;
    seenThreads.add(message.providerThreadId);
    const recipientKey = [...normalizeAddressSet(message.to)].sort().join(",");
    if (seenRecipients.has(recipientKey)) {
      fallback.push(message);
      continue;
    }
    seenRecipients.add(recipientKey);
    distinct.push(message);
  }
  return [...distinct, ...fallback].slice(0, MAX_SAMPLES);
}

function renderSamples(accountName: string, samples: SentMessage[]): string {
  const blocks = samples.map((message, index) => {
    const body =
      message.bodyText.length > MAX_BODY_CHARS
        ? `${message.bodyText.slice(0, MAX_BODY_CHARS)}\n[truncated]`
        : message.bodyText;
    return `--- Message ${index + 1} ---
To: ${message.to.join(", ")}
Subject: ${message.subject}
Date: ${message.date}

${body}`;
  });
  return `Sent messages from ${accountName} (${samples.length} samples, newest first):

${blocks.join("\n\n")}

Report this account's writing style via report_style as instructed.`;
}

interface LearnedVoice {
  style: string[];
}

/** narrow re-checks the shape since report params are untrusted, trimming and dropping blank entries. */
const reportStyleTool: ReportToolSpec<LearnedVoice> = {
  name: "report_style",
  label: "Report writing style",
  description:
    `Record the writing-style analysis for this account. Call this exactly once, after reading ` +
    `the sample messages, to finish the job.`,
  parameters: Type.Object({
    style: Type.Array(Type.String(), {
      minItems: 1,
      description:
        `3-6 short, self-contained directives another assistant can follow when drafting as ` +
        `this account, one aspect per entry — typical greeting, typical sign-off, ` +
        `formality/tone, typical message length, language(s) used and when, and any quirks or ` +
        `audience shifts (e.g. formal with clients, casual with colleagues). Each entry is ONE ` +
        `sentence, written as an instruction ("Greets clients with 'Hallo Herr/Frau <Nachname>' ` +
        `…"), not an observation about counts, and under 280 characters.`,
    }),
  }),
  narrow: (params) => {
    const { style } = (params ?? {}) as Record<string, unknown>;
    // Per-entry and count caps keep the combined style file under MEMORY_MAX_LENGTH.
    return {
      style: Array.isArray(style)
        ? style
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().slice(0, 300))
            .filter(Boolean)
            .slice(0, 6)
        : [],
    };
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bounded retry for transient fetch failures: the on-connect run can race freshly-created proxy credentials. A clean answer, even empty, returns as-is. */
async function fetchSentSample(
  provider: NonNullable<ReturnType<typeof getMailReadProvider>>,
  account: ConnectedAccount,
  attempts: number,
  retryDelayMs: number,
): Promise<SentMessage[]> {
  const since = new Date(Date.now() - SAMPLE_WINDOW_MS).toISOString();
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.listSentSince(account, since, { limit: FETCH_LIMIT });
    } catch (error) {
      if (attempt >= attempts) throw error;
      log.warn(
        { err: errorMessage(error), accountId: account.id, attempt },
        "sent-mail fetch failed — retrying",
      );
      await sleep(retryDelayMs);
    }
  }
}

async function learnVoiceCore(
  accountId: string,
  fetchAttempts = 1,
  fetchRetryDelayMs = 0,
): Promise<AccountVoice> {
  const account = (await listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`No connected account with id ${accountId}.`);
  if (!account.name.includes("@")) {
    throw new Error(`${account.name} is not an email account — voice learning needs sent mail.`);
  }
  const provider = getMailReadProvider(account.app);
  if (!provider) {
    throw new Error(`Voice learning isn't supported for ${account.appName} accounts yet.`);
  }

  const sent = await fetchSentSample(provider, account, fetchAttempts, fetchRetryDelayMs);
  const samples = sampleSentMessages(sent);
  if (samples.length === 0) {
    throw new NoSentMailError(
      `${account.name} has no recent sent mail to learn from — write a few emails first.`,
    );
  }

  const learned = await runReportPrompt({
    systemPrompt: systemPromptFor(account.name, await appLanguageName()),
    tool: reportStyleTool,
    prompt: renderSamples(account.name, samples),
    missingReportError: "the style analysis finished without calling report_style — try again",
  });

  // Write-then-delete: create the new style memory (ONE combined file per
  // account, one directive per line) and persist the voice pointing at it
  // FIRST, then delete the previous run's memories. Deleting first risks a
  // mid-run failure leaving the account with no style directives; an orphaned
  // old memory is recoverable, a lost voice is not. A create failure ("memory
  // is full") throws and is recorded as this learn's error, leaving the
  // previous voice intact.
  const styleMemoryIds: string[] = [];
  const body = learned.style.map((directive) => `- ${directive}`).join("\n");
  if (body) {
    // A dedup hit returns the existing entry; still record its id so a future re-learn replaces it too.
    const { entry } = await createMemory(body, "agent", accountId);
    styleMemoryIds.push(entry.id);
  }

  // patchAccountVoice swaps only this account's slot against the on-disk array
  // at write time, so a parallel learn for another account can't erase this
  // result. previous is captured inside the patch: the freshest view of which
  // memories the new ones replace.
  let previous: AccountVoice | undefined;
  const next = await patchAccountVoice(accountId, (existing) => {
    previous = existing;
    return {
      accountId,
      learnedAt: new Date().toISOString(),
      styleMemoryIds,
    };
  });

  // Only now delete the previous run's style directives (not user-written
  // memories); skip ids a dedup hit reused, and don't let one bad delete abort
  // the rest: the voice is already saved, so a failure here just orphans a
  // recoverable memory.
  for (const id of previous?.styleMemoryIds ?? []) {
    if (styleMemoryIds.includes(id)) continue;
    try {
      await deleteMemory(id);
    } catch (error) {
      log.warn({ err: error, accountId, memoryId: id }, "failed to delete old style memory");
    }
  }

  return next;
}

/**
 * Fold nightly draft-vs-sent lessons into the account's single style memory,
 * creating it (and registering it on the voice) when none exists. Lines the
 * file already holds are skipped; once the file is full the rest are dropped —
 * the next voice_learn re-derives style from scratch. Returns how many
 * directives were actually added.
 */
export async function mergeStyleDirectives(
  accountId: string,
  directives: string[],
): Promise<number> {
  const dedupKey = (line: string) =>
    line
      .replace(/^[-*]\s*/, "")
      .replace(/\s+/g, " ")
      .replace(/\.$/, "")
      .trim()
      .toLowerCase();

  const voice = (await getAccountVoices()).find((v) => v.accountId === accountId);
  const memories = await listMemories();
  const byId = new Map(memories.map((m) => [m.id, m]));
  const target = (voice?.styleMemoryIds ?? [])
    .map((id) => byId.get(id))
    .find((m) => m !== undefined);

  let content = target?.content ?? "";
  const seen = new Set(content.split("\n").map(dedupKey));
  let added = 0;
  for (const directive of directives) {
    const key = dedupKey(directive);
    if (!key || seen.has(key)) continue;
    const next = content ? `${content}\n- ${directive}` : `- ${directive}`;
    if (next.length > MEMORY_MAX_LENGTH) break;
    seen.add(key);
    content = next;
    added++;
  }
  if (added === 0) return 0;

  if (target) {
    // updateMemory renames the file when content changes; keep the voice's
    // pointer current so the next learn still replaces this file.
    const entry = await updateMemory(target.id, content);
    if (entry && entry.id !== target.id) {
      await patchAccountVoice(accountId, (existing) => ({
        ...existing,
        accountId,
        styleMemoryIds: (existing?.styleMemoryIds ?? []).map((id) =>
          id === target.id ? entry.id : id,
        ),
      }));
    }
  } else {
    const { entry } = await createMemory(content, "agent", accountId);
    await patchAccountVoice(accountId, (existing) => ({
      ...existing,
      accountId,
      styleMemoryIds: [...(existing?.styleMemoryIds ?? []), entry.id],
    }));
  }
  return added;
}

export const voiceLearnTool: AgentTool = tool({
  name: "voice_learn",
  label: "Learn account voice",
  description:
    `Analyze an account's sent mail to learn the user's writing style, then save the style ` +
    `as memories scoped to that account (used for every future draft). Use when the user ` +
    `asks to learn or mimic their style from past emails.`,
  account: "required",
  accountDescription: "The connected account's email address to learn from.",
  params: {},
  catchToText: true,
  execute: async (_params, { account }) => {
    const voice = await recordedLearn(account.id, () => learnVoiceCore(account.id));

    // Look the directives back up by id: the learn returns only the voice
    // record, not their text. The content is already a bulleted list.
    const memories = await listMemories();
    const byId = new Map(memories.map((m) => [m.id, m.content]));
    const styleLines = (voice.styleMemoryIds ?? [])
      .map((id) => byId.get(id))
      .filter((content): content is string => !!content);
    const styleText =
      styleLines.length > 0
        ? `Learned ${account.name}'s writing style, saved as a memory for this account ` +
          `(review or edit it on the Knowledge page):\n${styleLines.join("\n")}`
        : `No consistent writing-style pattern was found for ${account.name}.`;

    return textResult(styleText);
  },
});

/**
 * Automatic learning for connected email accounts (connect flow + boot
 * reconcile). Never blocks or crashes the connect flow: every failure path
 * stays quiet and best-effort.
 */

const CONNECT_FETCH_ATTEMPTS = 3;
const CONNECT_FETCH_RETRY_DELAY_MS = 10_000;

export interface VoiceLearnDeps {
  listAccounts: (opts?: { refresh?: boolean }) => Promise<ConnectedAccount[]>;
  modelConfigured: () => Promise<boolean>;
  learn: (accountId: string) => Promise<unknown>;
}

const defaultDeps: VoiceLearnDeps = {
  listAccounts: (opts) => listAccounts(opts),
  modelConfigured: () => activeModelConfigured(),
  // The unguarded core; recordedLearn holds the in-flight guard around the whole run.
  learn: (accountId) =>
    learnVoiceCore(accountId, CONNECT_FETCH_ATTEMPTS, CONNECT_FETCH_RETRY_DELAY_MS),
};

/** Refreshed ({ refresh: true }) so a just-linked account is visible. */
async function resolveEmailAccount(
  accountId: string,
  deps: VoiceLearnDeps,
): Promise<ConnectedAccount | null> {
  const accounts = await deps.listAccounts({ refresh: true });
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return null;
  return (EMAIL_APPS as readonly string[]).includes(account.app) ? account : null;
}

/**
 * Never throws. Skips (no LLM, not an email account) are thrown as errors so
 * they stay visible and retryable in Settings; a concurrent duplicate belongs
 * to the learn already in flight and records nothing.
 */
export async function runVoiceLearnOnConnect(
  accountId: string,
  deps: VoiceLearnDeps = defaultDeps,
): Promise<void> {
  if (inFlight.has(accountId)) return;
  try {
    await recordedLearn(accountId, async () => {
      if (!(await deps.modelConfigured())) {
        throw new Error(NO_MODEL_ERROR);
      }
      if (!(await resolveEmailAccount(accountId, deps))) {
        throw new Error("not a connected email account");
      }
      await deps.learn(accountId);
    });
    log.info({ accountId }, "voice learn finished");
  } catch (error) {
    if (error instanceof NoSentMailError) {
      log.info({ accountId }, "voice learn skipped: no sent mail to learn from");
    } else {
      log.warn({ err: errorMessage(error), accountId }, "voice learn failed");
    }
  }
}

/** Fire-and-forget: the run never rejects and manages its own lifetime, so the caller (an HTTP route) isn't blocked. */
export function startVoiceLearnOnConnect(accountId: string): void {
  void runVoiceLearnOnConnect(accountId);
}

/**
 * Boot catch-up: learn every connected email account with no attempt row and
 * no saved voice. Attempted-but-failed accounts are left alone (their error
 * rows are the user's to retry; auto-retrying every boot could hammer a broken
 * account), except a NO_MODEL_ERROR row, which this boot has already disproved.
 * Runs sequentially: a burst of parallel model calls would spike provider and
 * LLM rate limits at boot. Never throws.
 */
export async function reconcileVoiceLearns(deps: VoiceLearnDeps = defaultDeps): Promise<void> {
  try {
    await failInterruptedVoiceLearnRuns();
    if (!(await deps.modelConfigured())) {
      log.info("voice-learn reconcile skipped: no LLM configured");
      return;
    }
    const [accounts, runs, voices] = await Promise.all([
      deps.listAccounts(),
      listVoiceLearnRuns(),
      getAccountVoices(),
    ]);
    const attempted = new Set(
      runs.filter((run) => run.error !== NO_MODEL_ERROR).map((run) => run.accountId),
    );
    const learned = new Set(voices.map((voice) => voice.accountId));
    for (const account of accounts) {
      if (!(EMAIL_APPS as readonly string[]).includes(account.app)) continue;
      if (attempted.has(account.id) || learned.has(account.id)) continue;
      log.info({ accountId: account.id }, "voice-learn reconcile: learning account");
      await runVoiceLearnOnConnect(account.id, deps);
    }
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "voice-learn reconcile failed");
  }
}
