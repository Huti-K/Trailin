import type { ConnectedAccount } from "@trailin/shared";

/**
 * Sync-provider abstraction: every mail app Trailin can mirror locally
 * implements this interface against its own change-feed API — Gmail via
 * history.list (../gmailSync.ts), Outlook via Microsoft Graph delta
 * queries (../outlookSync.ts), the demo mailbox via the seeded store
 * (demo/demoSync.ts). Mirrors the DraftProvider registry in ../providers.ts:
 * adding a provider is one new file plus one import line in
 * registerSyncProviders.ts — nothing else changes.
 *
 * The cursor is OPAQUE. Whatever resume state a provider needs (Gmail's
 * historyId, Graph's per-folder delta links, a mid-backfill page token) it
 * encodes into the string itself — typically as JSON. The engine only ever
 * stores it and hands it back; nothing outside the provider file may inspect
 * it. That is what keeps the engine, the store, and every downstream feature
 * (summaries, triage, drafts) 100% provider-neutral.
 */

/** One message in provider-neutral form — all a SyncProvider may say about mail. */
export interface SyncMessage {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  /** Sender in display form, "Name <addr>" or bare address. */
  from: string;
  to: string[];
  cc: string[];
  /** ISO 8601 — used for all ordering, so it must be present and sane. */
  date: string;
  /** Short preview; the provider's own snippet or a truncated body. */
  snippet: string;
  /** Plain-text body, best effort (HTML stripped when that's all there is). */
  bodyText: string;
  /** Sent by this account (vs received). */
  isFromMe: boolean;
  isUnread: boolean;
  /** Raw provider labels/folders, for debugging and future capabilities. */
  labels: string[];
}

export interface SyncPage {
  upserts: SyncMessage[];
  /** Provider message ids gone from the mailbox (deleted, or moved to trash/spam). */
  deletes: string[];
  /** Opaque cursor to persist once this page is applied; resumes after restarts. */
  cursor: string;
  /** More changes immediately available — the engine calls fetchChanges again now. */
  hasMore: boolean;
}

export interface SyncOptions {
  /** Initial backfill window (cursor === null): how far back to fetch. */
  backfillDays: number;
  /** Soft cap on messages per page — keeps transactions and memory bounded. */
  pageSize: number;
}

/**
 * Thrown by fetchChanges when the provider no longer honors a non-null cursor
 * (Gmail historyId aged out, Graph delta token invalidated). The engine
 * resets to a fresh bounded backfill. Never thrown for cursor === null.
 */
export class SyncCursorExpiredError extends Error {
  constructor(message = "sync cursor expired") {
    super(message);
    this.name = "SyncCursorExpiredError";
  }
}

export interface SyncProvider {
  /**
   * Fetch the next page of mailbox changes. cursor === null means "start an
   * initial backfill bounded by opts.backfillDays"; otherwise resume from
   * where the returned cursor left off. Drafts, spam and trash are not mail —
   * providers must exclude them (and emit deletes when messages move there).
   */
  fetchChanges(
    account: ConnectedAccount,
    cursor: string | null,
    opts: SyncOptions,
  ): Promise<SyncPage>;
}

/**
 * Decode one provider's opaque cursor string: JSON-parse plus the provider's
 * own shape check. Returns null for a null cursor, unparseable JSON, or a
 * shape `isValid` rejects — since nothing outside the provider file ever
 * writes the string, all three mean the same thing: no usable resume state.
 * Each provider decides what that implies (restart the backfill, throw
 * SyncCursorExpiredError, start fresh).
 */
export function parseOpaqueCursor<T>(
  cursor: string | null,
  isValid: (value: unknown) => value is T,
): T | null {
  if (cursor === null) return null;
  try {
    const parsed: unknown = JSON.parse(cursor);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const registry = new Map<string, SyncProvider>();

/** Called once per provider module, at import time (see registerSyncProviders.ts). */
export function registerSyncProvider(app: string, provider: SyncProvider): void {
  registry.set(app, provider);
}

/** null when `app` has no sync driver yet — callers must handle that, not assume Gmail. */
export function getSyncProvider(app: string): SyncProvider | null {
  return registry.get(app) ?? null;
}
