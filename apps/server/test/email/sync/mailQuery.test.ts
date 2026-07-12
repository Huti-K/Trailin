import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EnrichmentResult, ThreadSnapshot } from "../../../src/email/enrich/enrichStore.js";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — so, same
// as test/agent/turnRecorder.test.ts, this suite gets its own scratch
// database by pointing DATABASE_PATH at a fresh temp file before anything
// pulls db/index.ts in, then importing everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-mail-query-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { saveEnrichment } = await import("../../../src/email/enrich/enrichStore.js");
const { searchMail, listThreadOverviews, getThreadDetail, listSentMessages } = await import(
  "../../../src/email/sync/mailQuery.js"
);

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

/** Hand-rolled snapshot: only threadId/accountId/inputHash/takenAt matter to saveEnrichment. */
function enrich(
  mirrorThreadId: string,
  accountId: string,
  overrides: Partial<EnrichmentResult> = {},
): void {
  const snapshot: ThreadSnapshot = {
    threadId: mirrorThreadId,
    accountId,
    subject: "",
    inputHash: "test-hash",
    takenAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
  const result: EnrichmentResult = {
    gist: "gist text",
    summary: "summary text",
    actionItems: [],
    triage: "fyi",
    urgency: "normal",
    awaitingReply: false,
    ...overrides,
  };
  saveEnrichment(snapshot, result, "test-model");
}

describe("searchMail", () => {
  const acctA = "acct-search-a";
  const acctB = "acct-search-b";

  seed(acctA, [
    message({
      providerMessageId: "m-zephyr-a",
      providerThreadId: "t-zephyr-a",
      subject: "Zephyr project kickoff",
      from: "alice@example.com",
      bodyText: "Let's schedule the zephyr project kickoff for Monday morning.",
      date: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  seed(acctB, [
    message({
      providerMessageId: "m-zephyr-b",
      providerThreadId: "t-zephyr-b",
      subject: "Zephyr updates",
      from: "carol@example.com",
      bodyText: "Another zephyr note for a different account.",
      date: "2026-01-02T00:00:00.000Z",
    }),
  ]);
  seed(acctA, [
    message({
      providerMessageId: "m-limit-1",
      providerThreadId: "t-limit-1",
      subject: "Limit test one",
      bodyText: "This message contains the limittest marker.",
      date: "2026-01-03T00:00:00.000Z",
    }),
    message({
      providerMessageId: "m-limit-2",
      providerThreadId: "t-limit-2",
      subject: "Limit test two",
      bodyText: "This message contains the limittest marker.",
      date: "2026-01-04T00:00:00.000Z",
    }),
    message({
      providerMessageId: "m-limit-3",
      providerThreadId: "t-limit-3",
      subject: "Limit test three",
      bodyText: "This message contains the limittest marker.",
      date: "2026-01-05T00:00:00.000Z",
    }),
  ]);

  it("matches on the strict AND of every term when all terms co-occur", () => {
    const hits = searchMail("zephyr kickoff", { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      accountId: acctA,
      providerMessageId: "m-zephyr-a",
      providerThreadId: "t-zephyr-a",
      subject: "Zephyr project kickoff",
      from: "alice@example.com",
    });
    expect(hits[0]?.to).toEqual(["recipient@example.com"]);
    expect(typeof hits[0]?.snippet).toBe("string");
  });

  it("falls back to OR when no row matches every term", () => {
    // No seeded row contains both "zephyr" and this made-up term, so the
    // strict AND pass returns nothing and the OR fallback is what surfaces
    // the zephyr hits.
    const hits = searchMail("zephyr made-up-term-nobody-wrote", { limit: 10 });
    const ids = hits.map((h) => h.providerMessageId);
    expect(ids).toContain("m-zephyr-a");
    expect(ids).toContain("m-zephyr-b");
  });

  it("scopes results to accountId when given", () => {
    const hits = searchMail("zephyr", { accountId: acctB, limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.accountId).toBe(acctB);
    expect(hits[0]?.providerMessageId).toBe("m-zephyr-b");
  });

  it("returns hits from every account when accountId is omitted", () => {
    const hits = searchMail("zephyr", { limit: 10 });
    expect(hits.map((h) => h.accountId).sort()).toEqual([acctA, acctB]);
  });

  it("caps the result count at limit", () => {
    const hits = searchMail("limittest", { limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("listThreadOverviews", () => {
  const acctA = "acct-ovw-a";
  const acctB = "acct-ovw-b";

  // Plain thread, no enrichment yet — oldest of the account-A threads.
  seed(acctA, [
    message({
      providerMessageId: "m-ovw-recent",
      providerThreadId: "t-ovw-recent",
      subject: "Recent A1",
      date: "2026-02-01T00:00:00.000Z",
      isUnread: false,
    }),
  ]);
  // Has an unread message.
  seed(acctA, [
    message({
      providerMessageId: "m-ovw-unread",
      providerThreadId: "t-ovw-unread",
      subject: "Unread A2",
      date: "2026-02-02T00:00:00.000Z",
      isUnread: true,
    }),
  ]);
  // needs_attention via triage, normal urgency.
  seed(acctA, [
    message({
      providerMessageId: "m-ovw-needs-reply",
      providerThreadId: "t-ovw-needs-reply",
      subject: "Needs reply A3",
      date: "2026-02-03T00:00:00.000Z",
    }),
  ]);
  enrich(`${acctA}:t-ovw-needs-reply`, acctA, {
    triage: "needs_reply",
    urgency: "normal",
    gist: "Needs a reply",
  });
  // needs_attention via high urgency, otherwise-quiet triage.
  seed(acctA, [
    message({
      providerMessageId: "m-ovw-high-urgency",
      providerThreadId: "t-ovw-high-urgency",
      subject: "High urgency A4",
      date: "2026-02-04T00:00:00.000Z",
    }),
  ]);
  enrich(`${acctA}:t-ovw-high-urgency`, acctA, {
    triage: "done",
    urgency: "high",
    gist: "Urgent but formally done",
  });
  // Enriched but neither condition of needs_attention holds.
  seed(acctA, [
    message({
      providerMessageId: "m-ovw-fyi",
      providerThreadId: "t-ovw-fyi",
      subject: "FYI A5",
      date: "2026-02-05T00:00:00.000Z",
    }),
  ]);
  enrich(`${acctA}:t-ovw-fyi`, acctA, { triage: "fyi", urgency: "low" });
  // Different account entirely, for the account-filter assertions.
  seed(acctB, [
    message({
      providerMessageId: "m-ovw-b1",
      providerThreadId: "t-ovw-b1",
      subject: "Account B thread",
      date: "2026-02-06T00:00:00.000Z",
    }),
  ]);

  it("'recent' returns every thread across accounts, newest first", () => {
    const overviews = listThreadOverviews({ filter: "recent", limit: 50 });
    const subjects = overviews
      .filter((o) => o.providerThreadId.startsWith("t-ovw-"))
      .map((o) => o.subject);
    expect(subjects).toEqual([
      "Account B thread",
      "FYI A5",
      "High urgency A4",
      "Needs reply A3",
      "Unread A2",
      "Recent A1",
    ]);
  });

  it("'recent' scoped to accountId only returns that account's threads", () => {
    const overviews = listThreadOverviews({ filter: "recent", accountId: acctA, limit: 50 });
    expect(overviews.every((o) => o.accountId === acctA)).toBe(true);
    expect(overviews.some((o) => o.providerThreadId === "t-ovw-b1")).toBe(false);
  });

  it("parses participants as a string array and reports unread/from-me flags", () => {
    const overviews = listThreadOverviews({ filter: "recent", accountId: acctA, limit: 50 });
    const recent = overviews.find((o) => o.providerThreadId === "t-ovw-recent");
    expect(recent).toBeDefined();
    expect(Array.isArray(recent?.participants)).toBe(true);
    expect(recent?.participants).toContain("sender@example.com");
    expect(recent?.hasUnread).toBe(false);
    expect(recent?.messageCount).toBe(1);
  });

  it("carries null enrichment fields for a thread with no mail_thread_state row", () => {
    const overviews = listThreadOverviews({ filter: "recent", accountId: acctA, limit: 50 });
    const recent = overviews.find((o) => o.providerThreadId === "t-ovw-recent");
    expect(recent).toMatchObject({ gist: null, triage: null, urgency: null, deadline: null });
  });

  it("carries the enrichment row's fields for an enriched thread", () => {
    const overviews = listThreadOverviews({ filter: "recent", accountId: acctA, limit: 50 });
    const needsReply = overviews.find((o) => o.providerThreadId === "t-ovw-needs-reply");
    expect(needsReply).toMatchObject({
      gist: "Needs a reply",
      triage: "needs_reply",
      urgency: "normal",
    });
  });

  it("'unread' only returns threads with at least one unread message", () => {
    const overviews = listThreadOverviews({ filter: "unread", accountId: acctA, limit: 50 });
    expect(overviews.map((o) => o.providerThreadId)).toEqual(["t-ovw-unread"]);
  });

  it("'needs_attention' matches on triage OR high urgency, and excludes plain/fyi threads", () => {
    const overviews = listThreadOverviews({
      filter: "needs_attention",
      accountId: acctA,
      limit: 50,
    });
    const ids = overviews.map((o) => o.providerThreadId).sort();
    expect(ids).toEqual(["t-ovw-high-urgency", "t-ovw-needs-reply"]);
  });

  it("respects limit", () => {
    const overviews = listThreadOverviews({ filter: "recent", accountId: acctA, limit: 2 });
    expect(overviews).toHaveLength(2);
  });
});

describe("getThreadDetail", () => {
  const acctA = "acct-detail-a";
  const acctB = "acct-detail-b";

  // Two messages seeded out of chronological order, to prove the read path
  // sorts by date rather than insertion order.
  seed(acctA, [
    message({
      providerMessageId: "m-detail-2",
      providerThreadId: "t-detail-1",
      subject: "Detail thread",
      from: "bob@example.com",
      to: ["alice@example.com"],
      cc: ["carol@example.com"],
      bodyText: "Second message.",
      date: "2026-03-02T00:00:00.000Z",
    }),
  ]);
  seed(acctA, [
    message({
      providerMessageId: "m-detail-1",
      providerThreadId: "t-detail-1",
      subject: "Detail thread",
      from: "alice@example.com",
      to: ["bob@example.com"],
      cc: [],
      bodyText: "First message.",
      date: "2026-03-01T00:00:00.000Z",
    }),
  ]);

  // Same provider thread id reused across two accounts, to exercise the
  // "newest-active thread wins" tie-break when accountId is omitted.
  seed(acctA, [
    message({
      providerMessageId: "m-clash-a",
      providerThreadId: "t-clash",
      subject: "Clash from account A (older)",
      date: "2026-03-05T00:00:00.000Z",
    }),
  ]);
  seed(acctB, [
    message({
      providerMessageId: "m-clash-b",
      providerThreadId: "t-clash",
      subject: "Clash from account B (newer)",
      date: "2026-03-06T00:00:00.000Z",
    }),
  ]);

  it("returns null for an unknown provider thread id", () => {
    expect(getThreadDetail("no-such-thread")).toBeNull();
  });

  it("looks up by provider thread id, scoped to accountId", () => {
    const detail = getThreadDetail("t-detail-1", acctA);
    expect(detail).toMatchObject({
      accountId: acctA,
      providerThreadId: "t-detail-1",
      subject: "Detail thread",
    });
  });

  it("orders messages by date ascending regardless of insertion order", () => {
    const detail = getThreadDetail("t-detail-1", acctA);
    expect(detail?.messages.map((m) => m.providerMessageId)).toEqual(["m-detail-1", "m-detail-2"]);
  });

  it("parses to/cc as string arrays", () => {
    const detail = getThreadDetail("t-detail-1", acctA);
    const second = detail?.messages.find((m) => m.providerMessageId === "m-detail-2");
    expect(second?.to).toEqual(["alice@example.com"]);
    expect(second?.cc).toEqual(["carol@example.com"]);
    const first = detail?.messages.find((m) => m.providerMessageId === "m-detail-1");
    expect(first?.cc).toEqual([]);
  });

  it("without accountId, resolves a cross-account id clash to the most recently active thread", () => {
    const detail = getThreadDetail("t-clash");
    expect(detail?.accountId).toBe(acctB);
    expect(detail?.subject).toBe("Clash from account B (newer)");
  });

  it("with accountId, narrows to that account's copy of a clashing thread id", () => {
    const detail = getThreadDetail("t-clash", acctA);
    expect(detail?.accountId).toBe(acctA);
    expect(detail?.subject).toBe("Clash from account A (older)");
  });
});

describe("listSentMessages", () => {
  const acctA = "acct-sent-a";
  const acctB = "acct-sent-b";

  seed(acctA, [
    message({
      providerMessageId: "m-sent-old",
      providerThreadId: "t-sent-1",
      subject: "Sent old",
      to: ["dana@example.com"],
      snippet: "Older sent snippet",
      isFromMe: true,
      date: "2026-04-01T00:00:00.000Z",
    }),
    message({
      providerMessageId: "m-sent-new",
      providerThreadId: "t-sent-2",
      subject: "Sent new",
      to: ["erin@example.com"],
      snippet: "Newer sent snippet",
      isFromMe: true,
      date: "2026-04-03T00:00:00.000Z",
    }),
    message({
      providerMessageId: "m-received",
      providerThreadId: "t-sent-3",
      subject: "Received, not sent",
      isFromMe: false,
      date: "2026-04-02T00:00:00.000Z",
    }),
  ]);
  seed(acctB, [
    message({
      providerMessageId: "m-sent-other-account",
      providerThreadId: "t-sent-b1",
      subject: "Sent from the other account",
      isFromMe: true,
      date: "2026-04-04T00:00:00.000Z",
    }),
  ]);

  it("only returns is_from_me messages for the given account, newest first", () => {
    const sent = listSentMessages(acctA, 10);
    expect(sent.map((s) => s.providerMessageId)).toEqual(["m-sent-new", "m-sent-old"]);
  });

  it("parses to as a string array", () => {
    const sent = listSentMessages(acctA, 10);
    expect(sent[0]?.to).toEqual(["erin@example.com"]);
  });

  it("respects limit", () => {
    const sent = listSentMessages(acctA, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.providerMessageId).toBe("m-sent-new");
  });

  it("never crosses into another account's sent messages", () => {
    const sent = listSentMessages(acctA, 10);
    expect(sent.some((s) => s.providerMessageId === "m-sent-other-account")).toBe(false);
  });
});
