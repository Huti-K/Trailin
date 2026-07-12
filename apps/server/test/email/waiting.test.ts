import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedAccount } from "@trailin/shared";
import { afterAll, describe, expect, it } from "vitest";
import type { EnrichmentResult, ThreadSnapshot } from "../../src/email/enrich/enrichStore.js";
import type { SyncMessage } from "../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — same
// pattern as test/email/enrich/enrichStore.test.ts: point DATABASE_PATH at a
// fresh temp file before anything pulls db/index.ts in, then import
// everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-waiting-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../src/db/index.js");
const { applySyncPage } = await import("../../src/email/sync/mailStore.js");
const { saveEnrichment, dismissThread } = await import("../../src/email/enrich/enrichStore.js");
const { listOpenConversations, listWaitingOnOthers } = await import("../../src/email/waiting.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

/** Each describe block gets its own account so seeded threads never leak between suites. */
function accountFixture(id: string): ConnectedAccount {
  return {
    id,
    app: "gmail",
    name: "owner@example.com",
    healthy: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Fills in every SyncMessage field a fixture doesn't care about. */
function message(
  overrides: Partial<SyncMessage> & Pick<SyncMessage, "providerMessageId" | "providerThreadId">,
): SyncMessage {
  return {
    subject: "Test subject",
    from: "sender@example.com",
    to: ["owner@example.com"],
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

/** Seeds one thread's messages through the real write path, like the sync engine does. */
function seedThread(accountId: string, messages: SyncMessage[]): void {
  applySyncPage(accountId, { upserts: messages, deletes: [], cursor: "seed", hasMore: false });
}

/** Writes a mail_thread_state row for a mirrored thread via the real enrichStore write path. */
function enrich(
  accountId: string,
  providerThreadId: string,
  inputHash: string,
  result: Partial<EnrichmentResult> & Pick<EnrichmentResult, "triage" | "awaitingReply">,
): void {
  const snapshot: ThreadSnapshot = {
    threadId: `${accountId}:${providerThreadId}`,
    accountId,
    subject: "",
    inputHash,
    takenAt: new Date().toISOString(),
    messages: [],
  };
  saveEnrichment(
    snapshot,
    { gist: "", summary: "", actionItems: [], urgency: "normal", ...result },
    "test-model",
  );
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

describe("listOpenConversations — waiting on you", () => {
  const account = accountFixture("acct-oc-you");

  // Inbound, needs_reply, urgency high — oldest of the three but must sort first.
  seedThread(account.id, [
    message({
      providerMessageId: "m-you-high",
      providerThreadId: "t-you-high",
      from: "alice@example.com",
      date: daysAgo(3),
    }),
  ]);
  enrich(account.id, "t-you-high", "hash-you-high", {
    triage: "needs_reply",
    urgency: "high",
    gist: "Needs a decision by Friday.",
    awaitingReply: false,
  });

  // Inbound, needs_reply, urgency normal, newest of the normals.
  seedThread(account.id, [
    message({
      providerMessageId: "m-you-normal-newer",
      providerThreadId: "t-you-normal-newer",
      from: "bob@example.com",
      date: daysAgo(1),
    }),
  ]);
  enrich(account.id, "t-you-normal-newer", "hash-you-normal-newer", {
    triage: "needs_reply",
    urgency: "normal",
    gist: "Wants to confirm the time.",
    awaitingReply: false,
  });

  // Inbound, needs_reply, urgency normal, oldest of the normals.
  seedThread(account.id, [
    message({
      providerMessageId: "m-you-normal-older",
      providerThreadId: "t-you-normal-older",
      from: "carol@example.com",
      date: daysAgo(5),
    }),
  ]);
  enrich(account.id, "t-you-normal-older", "hash-you-normal-older", {
    triage: "needs_reply",
    urgency: "normal",
    gist: "Asking a follow-up question.",
    awaitingReply: false,
  });

  // Inbound but triaged fyi — must not appear.
  seedThread(account.id, [
    message({ providerMessageId: "m-you-fyi", providerThreadId: "t-you-fyi", date: daysAgo(1) }),
  ]);
  enrich(account.id, "t-you-fyi", "hash-you-fyi", { triage: "fyi", awaitingReply: false });

  // needs_reply, but the newest message is the owner's own (outbound) — must not appear.
  seedThread(account.id, [
    message({
      providerMessageId: "m-you-outbound",
      providerThreadId: "t-you-outbound",
      isFromMe: true,
      date: daysAgo(1),
    }),
  ]);
  enrich(account.id, "t-you-outbound", "hash-you-outbound", {
    triage: "needs_reply",
    awaitingReply: false,
  });

  it("includes only inbound needs_reply threads, urgency high first then newest", async () => {
    const { waitingOnYou } = await listOpenConversations(account);
    expect(waitingOnYou.map((t) => t.threadId)).toEqual([
      "t-you-high",
      "t-you-normal-newer",
      "t-you-normal-older",
    ]);
  });

  it("carries subject/counterpart/gist/urgency/webUrl for a waiting-on-you row", async () => {
    const { waitingOnYou } = await listOpenConversations(account);
    const row = waitingOnYou.find((t) => t.threadId === "t-you-high");
    expect(row).toMatchObject({
      accountId: account.id,
      subject: "Test subject",
      counterpart: "alice@example.com",
      gist: "Needs a decision by Friday.",
      urgency: "high",
    });
    expect(row?.webUrl).toContain("mail.google.com");
  });

  it("excludes fyi-triaged and outbound-last threads", async () => {
    const { waitingOnYou } = await listOpenConversations(account);
    const ids = waitingOnYou.map((t) => t.threadId);
    expect(ids).not.toContain("t-you-fyi");
    expect(ids).not.toContain("t-you-outbound");
  });
});

describe("listOpenConversations — dismissal", () => {
  const account = accountFixture("acct-oc-dismiss");

  seedThread(account.id, [
    message({ providerMessageId: "m-dismiss-1", providerThreadId: "t-dismiss", date: daysAgo(1) }),
  ]);
  enrich(account.id, "t-dismiss", "hash-dismiss-1", {
    triage: "needs_reply",
    awaitingReply: false,
  });

  it("is present before being dismissed", async () => {
    const { waitingOnYou } = await listOpenConversations(account);
    expect(waitingOnYou.map((t) => t.threadId)).toContain("t-dismiss");
  });

  it("disappears once dismissed", async () => {
    expect(dismissThread(account.id, "t-dismiss")).toBe(true);
    const { waitingOnYou } = await listOpenConversations(account);
    expect(waitingOnYou.map((t) => t.threadId)).not.toContain("t-dismiss");
  });

  it("returns false dismissing a thread with no enrichment state row", () => {
    expect(dismissThread(account.id, "no-such-thread")).toBe(false);
  });

  it("resurfaces once a new inbound message changes the thread's input_hash", async () => {
    // Simulates the effect of a new inbound message: enrichment reruns and
    // writes a fresh input_hash, which no longer matches dismissed_hash.
    enrich(account.id, "t-dismiss", "hash-dismiss-2", {
      triage: "needs_reply",
      awaitingReply: false,
    });
    const { waitingOnYou } = await listOpenConversations(account);
    expect(waitingOnYou.map((t) => t.threadId)).toContain("t-dismiss");
  });
});

describe("listOpenConversations / listWaitingOnOthers — waiting on others", () => {
  const account = accountFixture("acct-oc-others");

  // Sent 2 hours ago, awaiting a reply — must appear despite being under the
  // old 24h floor, since that floor no longer exists.
  seedThread(account.id, [
    message({
      providerMessageId: "m-other-recent",
      providerThreadId: "t-other-recent",
      isFromMe: true,
      to: ["dana@example.com"],
      date: hoursAgo(2),
    }),
  ]);
  enrich(account.id, "t-other-recent", "hash-other-recent", {
    triage: "waiting_on",
    awaitingReply: true,
  });

  // Sent 20 days ago — outside the 14-day outer window, must not appear.
  seedThread(account.id, [
    message({
      providerMessageId: "m-other-old",
      providerThreadId: "t-other-old",
      isFromMe: true,
      to: ["erin@example.com"],
      date: daysAgo(20),
    }),
  ]);
  enrich(account.id, "t-other-old", "hash-other-old", {
    triage: "waiting_on",
    awaitingReply: true,
  });

  // Sent recently but enrichment judged no reply is expected — must not appear.
  seedThread(account.id, [
    message({
      providerMessageId: "m-other-not-awaiting",
      providerThreadId: "t-other-not-awaiting",
      isFromMe: true,
      to: ["frank@example.com"],
      date: hoursAgo(3),
    }),
  ]);
  enrich(account.id, "t-other-not-awaiting", "hash-other-not-awaiting", {
    triage: "done",
    awaitingReply: false,
  });

  // Newest message is inbound, not from the owner — must not appear even if
  // awaiting_reply were somehow set.
  seedThread(account.id, [
    message({
      providerMessageId: "m-other-inbound",
      providerThreadId: "t-other-inbound",
      isFromMe: false,
      date: hoursAgo(1),
    }),
  ]);
  enrich(account.id, "t-other-inbound", "hash-other-inbound", {
    triage: "needs_reply",
    awaitingReply: true,
  });

  it("includes a recently-sent thread enrichment judged still awaiting a reply", async () => {
    const { waitingOnOthers } = await listOpenConversations(account);
    expect(waitingOnOthers.map((t) => t.threadId)).toContain("t-other-recent");
  });

  it("excludes a thread outside the 14-day window, one enrichment closed, and an inbound-last one", async () => {
    const { waitingOnOthers } = await listOpenConversations(account);
    const ids = waitingOnOthers.map((t) => t.threadId);
    expect(ids).not.toContain("t-other-old");
    expect(ids).not.toContain("t-other-not-awaiting");
    expect(ids).not.toContain("t-other-inbound");
  });

  it("listWaitingOnOthers (the agent-tool entry point) returns the same lane", async () => {
    const items = await listWaitingOnOthers(account);
    expect(items.map((t) => t.threadId)).toContain("t-other-recent");
    expect(items.map((t) => t.threadId)).not.toContain("t-other-old");
  });
});
