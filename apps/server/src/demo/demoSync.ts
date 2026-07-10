import type { ConnectedAccount } from "@trailin/shared";
import { logger } from "../logger.js";
import {
  parseOpaqueCursor,
  SyncCursorExpiredError,
  type SyncMessage,
  type SyncOptions,
  type SyncPage,
  type SyncProvider,
} from "../email/sync/syncProviders.js";
import { snippetFrom } from "../email/textUtils.js";
import { daysAgo } from "./content.js";
import { MAILBOX } from "./mailbox.js";

/**
 * Demo SyncProvider: mirrors the seeded MAILBOX (demo/mailbox.ts) into the
 * mailbox store instead of calling out to Gmail/Outlook/etc. In demo mode
 * registerSyncProviders.ts registers it for every email app LAST, so it
 * stands in for whichever real driver would own a demo account's app —
 * mirroring how demo/demoDrafts.ts replaces the real draft providers.
 *
 * MAILBOX is a hand-authored constant and nothing mutates it today, but
 * fetchChanges is written as if it could: every call re-reads the mailbox
 * fresh and diffs against what the cursor last saw, so a future demo tool
 * that appends or edits messages is picked up automatically.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One demo message flattened out of its thread, with everything a SyncMessage needs precomputed. */
interface DemoSyncCandidate {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: Date;
  body: string;
  isFromMe: boolean;
  isUnread: boolean;
}

/**
 * Opaque cursor. "backfill" pages through not-yet-emitted messages
 * opts.pageSize at a time, oldest first; once nothing is left to backfill it
 * flips to "steady", where every call just compares a cheap fingerprint of
 * the current state against the one recorded last time.
 */
interface DemoCursorState {
  phase: "backfill" | "steady";
  /** Sorted providerMessageIds already emitted for this account. */
  emitted: string[];
  /** `${count}|${sorted "id:unreadBit" tokens}`; only meaningful once phase is "steady". */
  fingerprint: string;
}

function isDemoCursorState(value: unknown): value is DemoCursorState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<DemoCursorState>;
  return (
    (v.phase === "backfill" || v.phase === "steady") &&
    Array.isArray(v.emitted) &&
    typeof v.fingerprint === "string"
  );
}

function parseCursor(raw: string | null): DemoCursorState {
  if (raw === null) return { phase: "backfill", emitted: [], fingerprint: "" };
  const parsed = parseOpaqueCursor(raw, isDemoCursorState);
  if (!parsed) {
    logger.debug("demo sync cursor unreadable — restarting backfill");
    throw new SyncCursorExpiredError();
  }
  return parsed;
}

/** Every message the demo account owns, oldest-agnostic order — callers sort as needed. */
function messagesForAccount(account: ConnectedAccount): DemoSyncCandidate[] {
  const out: DemoSyncCandidate[] = [];
  for (const thread of MAILBOX) {
    if (thread.accountId !== account.id) continue;
    thread.messages.forEach((message, index) => {
      // The demo mailbox has no separate "sent" marker; a message is from
      // the account holder when it carries that account's own address —
      // which is what feeds mail_threads.last_from_me, the flag
      // email/waiting.ts computes the "waiting on others" list from.
      const isFromMe = message.from.includes(account.name);
      out.push({
        id: `${thread.id}-m${index + 1}`,
        threadId: thread.id,
        subject: thread.subject,
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        date: daysAgo(message.daysAgo, message.hour, message.minute ?? 0),
        body: message.body,
        isFromMe,
        // DemoEmailMessage has no read/unread field at all. The nearest
        // honest proxy this data supports: the newest message in a thread is
        // "unread" when it arrived and the account holder hasn't answered it
        // yet — which flips automatically if a later reply gets appended.
        isUnread: !isFromMe && index === thread.messages.length - 1,
      });
    });
  }
  return out;
}

function fingerprintOf(messages: DemoSyncCandidate[]): string {
  const tokens = messages.map((m) => `${m.id}:${m.isUnread ? 1 : 0}`).sort();
  return `${messages.length}|${tokens.join(",")}`;
}

/** The demo mailbox's roomier ~200-char snippet cap, same as demo/emailTools.ts. */
const DEMO_SNIPPET_LENGTH = 200;

function toSyncMessage(m: DemoSyncCandidate): SyncMessage {
  return {
    providerMessageId: m.id,
    providerThreadId: m.threadId,
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date.toISOString(),
    snippet: snippetFrom(m.body, DEMO_SNIPPET_LENGTH),
    bodyText: m.body,
    isFromMe: m.isFromMe,
    isUnread: m.isUnread,
    labels: [],
  };
}

function byDateThenId(a: DemoSyncCandidate, b: DemoSyncCandidate): number {
  return a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id);
}

async function fetchChanges(
  account: ConnectedAccount,
  cursor: string | null,
  opts: SyncOptions,
): Promise<SyncPage> {
  const state = parseCursor(cursor);
  const windowStart = Date.now() - opts.backfillDays * DAY_MS;
  const eligible = messagesForAccount(account)
    .filter((m) => m.date.getTime() >= windowStart)
    .sort(byDateThenId);
  const currentIds = new Set(eligible.map((m) => m.id));
  const deletes = state.emitted.filter((id) => !currentIds.has(id));

  if (state.phase === "backfill") {
    const previouslyEmitted = new Set(state.emitted);
    const remaining = eligible.filter((m) => !previouslyEmitted.has(m.id));
    const batch = remaining.slice(0, opts.pageSize);
    const hasMore = remaining.length > batch.length;
    const emitted = [
      ...state.emitted.filter((id) => currentIds.has(id)),
      ...batch.map((m) => m.id),
    ].sort();
    const cursorState: DemoCursorState = hasMore
      ? { phase: "backfill", emitted, fingerprint: "" }
      : { phase: "steady", emitted, fingerprint: fingerprintOf(eligible) };
    return {
      upserts: batch.map(toSyncMessage),
      deletes,
      cursor: JSON.stringify(cursorState),
      hasMore,
    };
  }

  // Steady state: nothing left to backfill, so a full pass is cheap. The
  // fingerprint (ids + unread flags + count) is all that's checked on the
  // common "nothing happened" path; only on a real change do we build the
  // upsert list, and even then it's every eligible message rather than a
  // field-by-field diff — correct (upserts are idempotent) and simple,
  // which is the right trade at demo scale.
  const fingerprint = fingerprintOf(eligible);
  if (fingerprint === state.fingerprint && deletes.length === 0) {
    const unchangedCursor: DemoCursorState = { phase: "steady", emitted: state.emitted, fingerprint };
    return {
      upserts: [],
      deletes: [],
      cursor: cursor ?? JSON.stringify(unchangedCursor),
      hasMore: false,
    };
  }
  const changedCursor: DemoCursorState = {
    phase: "steady",
    emitted: eligible.map((m) => m.id).sort(),
    fingerprint,
  };
  return {
    upserts: eligible.map(toSyncMessage),
    deletes,
    cursor: JSON.stringify(changedCursor),
    hasMore: false,
  };
}

/** This module's SyncProvider — registered (demo mode only) by ../email/sync/registerSyncProviders.ts. */
export const demoSyncProvider: SyncProvider = { fetchChanges };
