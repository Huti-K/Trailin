import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EnrichmentResult, ThreadSnapshot } from "../../../src/email/enrich/enrichStore.js";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — same
// pattern as test/email/sync/mailQuery.test.ts: point DATABASE_PATH at a
// fresh temp file before anything pulls db/index.ts in, then import
// everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-enrich-store-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { findStaleCandidates, saveEnrichment, saveEnrichmentError, _selectStaleSqlForTest } =
  await import("../../../src/email/enrich/enrichStore.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

/** Fills in every SyncMessage field a fixture doesn't care about. */
function message(
  overrides: Partial<SyncMessage> & Pick<SyncMessage, "providerMessageId" | "providerThreadId">,
): SyncMessage {
  return {
    subject: "",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    cc: [],
    date: "2026-01-01T00:00:00.000Z",
    snippet: "",
    bodyText: "",
    isFromMe: false,
    isUnread: false,
    labels: [],
    ...overrides,
  };
}

/** Seeds through the real write path (applySyncPage), like the sync engine does. */
function seed(accountId: string, upserts: SyncMessage[]): void {
  applySyncPage(accountId, { upserts, deletes: [], cursor: "seed", hasMore: false });
}

/** Hand-rolled snapshot: only threadId/accountId/inputHash/takenAt matter to save*. */
function snapshotOf(mirrorThreadId: string, accountId: string, takenAt: string): ThreadSnapshot {
  return {
    threadId: mirrorThreadId,
    accountId,
    subject: "",
    inputHash: "test-hash",
    takenAt,
    messages: [],
  };
}

function enrichOk(mirrorThreadId: string, accountId: string, takenAt: string): void {
  const result: EnrichmentResult = {
    gist: "gist",
    summary: "summary",
    actionItems: [],
    triage: "fyi",
    urgency: "normal",
    awaitingReply: false,
  };
  saveEnrichment(snapshotOf(mirrorThreadId, accountId, takenAt), result, "test-model");
}

function enrichFail(
  mirrorThreadId: string,
  accountId: string,
  takenAt: string,
  error = "boom",
): void {
  saveEnrichmentError(snapshotOf(mirrorThreadId, accountId, takenAt), error);
}

describe("findStaleCandidates", () => {
  const acct = "acct-stale";
  // Comfortably outside ERROR_BACKOFF_MS (10 minutes) of "now".
  const FAR_PAST = "2020-01-01T00:00:00.000Z";

  // Never enriched — no mail_thread_state row at all.
  seed(acct, [
    message({
      providerMessageId: "m-never-1",
      providerThreadId: "t-never",
      date: "2026-05-01T00:00:00.000Z",
    }),
  ]);

  // Enriched and still current — must NOT be a candidate.
  seed(acct, [
    message({
      providerMessageId: "m-fresh-1",
      providerThreadId: "t-fresh",
      date: "2026-05-02T00:00:00.000Z",
    }),
  ]);
  enrichOk(`${acct}:t-fresh`, acct, new Date().toISOString());

  // Enriched in the past, then new mail arrived — updated_at now postdates
  // enriched_at.
  seed(acct, [
    message({
      providerMessageId: "m-stale-1",
      providerThreadId: "t-stale",
      date: "2026-05-03T00:00:00.000Z",
    }),
  ]);
  enrichOk(`${acct}:t-stale`, acct, FAR_PAST);
  seed(acct, [
    message({
      providerMessageId: "m-stale-2",
      providerThreadId: "t-stale",
      date: "2026-05-03T01:00:00.000Z",
    }),
  ]);

  // Failed long enough ago that the backoff has elapsed — must resurface.
  seed(acct, [
    message({
      providerMessageId: "m-err-cold-1",
      providerThreadId: "t-err-cold",
      date: "2026-05-04T00:00:00.000Z",
    }),
  ]);
  enrichFail(`${acct}:t-err-cold`, acct, FAR_PAST, "boom");

  // Failed moments ago — still inside the backoff window, must NOT resurface.
  seed(acct, [
    message({
      providerMessageId: "m-err-hot-1",
      providerThreadId: "t-err-hot",
      date: "2026-05-05T00:00:00.000Z",
    }),
  ]);
  enrichFail(`${acct}:t-err-hot`, acct, new Date().toISOString(), "still failing");

  it("returns exactly the never-enriched, stale, and cooled-down-errored threads", () => {
    const ids = findStaleCandidates(50)
      .map((c) => c.threadId)
      .sort();
    expect(ids).toEqual([`${acct}:t-err-cold`, `${acct}:t-never`, `${acct}:t-stale`].sort());
  });

  it("excludes a fresh (up to date) thread and a recently-errored one still in backoff", () => {
    const ids = findStaleCandidates(50).map((c) => c.threadId);
    expect(ids).not.toContain(`${acct}:t-fresh`);
    expect(ids).not.toContain(`${acct}:t-err-hot`);
  });

  it("orders every category together, newest last_message_at first", () => {
    const ids = findStaleCandidates(50).map((c) => c.threadId);
    // Last message dates: t-err-cold 05-04, t-stale 05-03T01, t-never 05-01.
    expect(ids).toEqual([`${acct}:t-err-cold`, `${acct}:t-stale`, `${acct}:t-never`]);
  });

  it("respects limit across the merged branches, keeping the overall newest", () => {
    const candidates = findStaleCandidates(2);
    expect(candidates.map((c) => c.threadId)).toEqual([`${acct}:t-err-cold`, `${acct}:t-stale`]);
  });

  it("carries the stored error/enriched_at for a previously-failed thread", () => {
    const errCold = findStaleCandidates(50).find((c) => c.threadId === `${acct}:t-err-cold`);
    expect(errCold?.lastError).toBe("boom");
    expect(errCold?.lastEnrichedAt).toBe(FAR_PAST);
  });

  it("carries null lastError/lastEnrichedAt for a never-enriched thread", () => {
    const never = findStaleCandidates(50).find((c) => c.threadId === `${acct}:t-never`);
    expect(never?.lastError).toBeNull();
    expect(never?.lastEnrichedAt).toBeNull();
  });
});

describe("selectStale query plan", () => {
  it("never does a full scan of mail_threads without an index", () => {
    const sql = _selectStaleSqlForTest();
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all({ limit: 20, errorCutoff: new Date().toISOString() }) as Array<{ detail: string }>;
    expect(plan.length).toBeGreaterThan(0);
    for (const row of plan) {
      // A bare "SCAN t" (no index) would mean the whole mail_threads table is
      // walked unindexed; every access to t in this query must instead go
      // through idx_mail_threads_last_message_at.
      if (/\bSCAN t\b/.test(row.detail)) {
        expect(row.detail).toContain("USING INDEX idx_mail_threads_last_message_at");
      }
      expect(row.detail).not.toMatch(/SCAN TABLE mail_threads/i);
    }
  });
});
