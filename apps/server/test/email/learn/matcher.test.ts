import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — same
// isolation dance as test/email/enrich/enrichStore.test.ts: point
// DATABASE_PATH at a fresh temp file before anything pulls db/index.ts in,
// then import everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-learn-match-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { createDraftSnapshot, getDraftStatus } = await import("../../../src/db/draftStore.js");
const { runMatchSweep } = await import("../../../src/email/learn/matcher.js");
type TiebreakInput = Parameters<NonNullable<Parameters<typeof runMatchSweep>[0]>>[0];

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

/** Fills in every SyncMessage field a fixture doesn't care about. Dates default
 *  to 2030 so they always postdate a snapshot's real-clock createdAt. */
function message(
  overrides: Partial<SyncMessage> & Pick<SyncMessage, "providerMessageId" | "providerThreadId">,
): SyncMessage {
  return {
    subject: "",
    from: "me@example.com",
    to: ["them@example.com"],
    cc: [],
    date: "2030-01-01T00:00:00.000Z",
    snippet: "",
    bodyText: "",
    isFromMe: true,
    isUnread: false,
    labels: [],
    ...overrides,
  };
}

function seed(accountId: string, upserts: SyncMessage[]): void {
  applySyncPage(accountId, { upserts, deletes: [], cursor: "seed", hasMore: false });
}

/** A timestamp `offsetMs` after the real clock — standalone drafts only match within a
 *  7-day window of their (real-clock) createdAt, so their candidates can't use the fixed
 *  far-future dates the thread-match tests use (no such window applies to those). */
function soon(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Fails the test loudly if the deterministic rules ever fall through to the tiebreak seam. */
async function neverCalledTiebreak(): Promise<string | null> {
  throw new Error("tiebreak should not have been called for a deterministic match");
}

describe("runMatchSweep — reply drafts (thread match)", () => {
  const accountId = "acct-thread-match";

  it("matches the earliest sent message in the same thread, ignoring a later one and other threads", async () => {
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-thread-1",
      threadId: "thread-1",
      subject: "Re: Project update",
      to: ["them@example.com"],
      signature: null,
      body: "Draft body.",
    });

    seed(accountId, [
      message({
        providerMessageId: "m-thread-late",
        providerThreadId: "thread-1",
        date: "2030-01-03T00:00:00.000Z",
      }),
      message({
        providerMessageId: "m-thread-early",
        providerThreadId: "thread-1",
        date: "2030-01-02T00:00:00.000Z",
      }),
      message({
        providerMessageId: "m-other-thread",
        providerThreadId: "thread-2",
        date: "2030-01-01T00:00:00.000Z",
      }),
    ]);

    await runMatchSweep(neverCalledTiebreak);

    expect(await getDraftStatus(accountId, "draft-thread-1")).toEqual({
      status: "sent",
      sentMessageId: "m-thread-early",
    });
  });

  it("leaves a reply draft open when nothing has landed in its thread yet", async () => {
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-thread-2",
      threadId: "thread-unanswered",
      subject: "Re: Still pending",
      to: ["them@example.com"],
      signature: null,
      body: "Draft body.",
    });

    await runMatchSweep(neverCalledTiebreak);

    expect(await getDraftStatus(accountId, "draft-thread-2")).toEqual({ status: "open" });
  });
});

describe("runMatchSweep — standalone drafts (recipients + subject match)", () => {
  const accountId = "acct-standalone-match";

  it("matches on normalized recipients and subject despite display names, case, and a reply prefix", async () => {
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-standalone-1",
      subject: "Invoice for March",
      to: ["Alice <alice@example.com>", "bob@example.com"],
      signature: null,
      body: "Draft body.",
    });

    seed(accountId, [
      message({
        providerMessageId: "m-standalone-hit",
        providerThreadId: "thread-x",
        subject: "Re: Invoice for March",
        to: ["ALICE@Example.com", "Bob <bob@example.com>"],
        date: soon(1_000),
      }),
      message({
        providerMessageId: "m-standalone-miss-subject",
        providerThreadId: "thread-y",
        subject: "Unrelated",
        to: ["alice@example.com", "bob@example.com"],
        date: soon(1_000),
      }),
      message({
        providerMessageId: "m-standalone-miss-recipient",
        providerThreadId: "thread-z",
        subject: "Invoice for March",
        to: ["carol@example.com"],
        date: soon(1_000),
      }),
    ]);

    await runMatchSweep(neverCalledTiebreak);

    expect(await getDraftStatus(accountId, "draft-standalone-1")).toEqual({
      status: "sent",
      sentMessageId: "m-standalone-hit",
    });
  });

  it("stays open when no candidate has been sent at all", async () => {
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-standalone-2",
      subject: "Nothing sent yet",
      to: ["dana@example.com"],
      signature: null,
      body: "Draft body.",
    });

    await runMatchSweep(neverCalledTiebreak);

    expect(await getDraftStatus(accountId, "draft-standalone-2")).toEqual({ status: "open" });
  });
});

describe("runMatchSweep — ambiguous standalone match falls to the injected tiebreak seam", () => {
  const accountId = "acct-tiebreak";

  async function seedAmbiguousDraft(providerDraftId: string): Promise<void> {
    await createDraftSnapshot({
      accountId,
      providerDraftId,
      subject: "Quick question",
      to: ["dana@example.com"],
      signature: null,
      body: "Are we still on for Friday?",
    });
    seed(accountId, [
      message({
        providerMessageId: `${providerDraftId}-cand-a`,
        providerThreadId: "t-a",
        subject: "Quick question",
        to: ["dana@example.com"],
        date: soon(1_000),
        bodyText: "Body A",
      }),
      message({
        providerMessageId: `${providerDraftId}-cand-b`,
        providerThreadId: "t-b",
        subject: "Quick question",
        to: ["dana@example.com"],
        date: soon(2_000),
        bodyText: "Body B",
      }),
    ]);
  }

  it("marks the candidate the seam picks, passing it the snapshot's latest body and every candidate", async () => {
    const providerDraftId = "draft-tiebreak-pick";
    await seedAmbiguousDraft(providerDraftId);

    let received: TiebreakInput | undefined;
    await runMatchSweep(async (input) => {
      received = input;
      return `${providerDraftId}-cand-b`;
    });

    expect(received?.latestBody).toBe("Are we still on for Friday?");
    expect(received?.candidates.map((c) => c.providerMessageId).sort()).toEqual(
      [`${providerDraftId}-cand-a`, `${providerDraftId}-cand-b`].sort(),
    );
    expect(
      received?.candidates.find((c) => c.providerMessageId === `${providerDraftId}-cand-b`)?.body,
    ).toBe("Body B");

    expect(await getDraftStatus(accountId, providerDraftId)).toEqual({
      status: "sent",
      sentMessageId: `${providerDraftId}-cand-b`,
    });
  });

  it("leaves the draft open when the seam reports no confident match", async () => {
    const providerDraftId = "draft-tiebreak-none";
    await seedAmbiguousDraft(providerDraftId);

    await runMatchSweep(async () => null);

    expect(await getDraftStatus(accountId, providerDraftId)).toEqual({ status: "open" });
  });

  it("leaves the draft open (and keeps sweeping other drafts) when the seam throws", async () => {
    const providerDraftId = "draft-tiebreak-error";
    await seedAmbiguousDraft(providerDraftId);

    // A second, deterministic draft in the same sweep proves one seam's
    // failure doesn't abort the rest of the sweep.
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-alongside-error",
      threadId: "thread-alongside",
      subject: "Re: Separate thread",
      to: ["dana@example.com"],
      signature: null,
      body: "Draft body.",
    });
    seed(accountId, [
      message({
        providerMessageId: "m-alongside",
        providerThreadId: "thread-alongside",
        date: "2030-03-01T00:00:00.000Z",
      }),
    ]);

    await runMatchSweep(async () => {
      throw new Error("boom");
    });

    expect(await getDraftStatus(accountId, providerDraftId)).toEqual({ status: "open" });
    expect(await getDraftStatus(accountId, "draft-alongside-error")).toEqual({
      status: "sent",
      sentMessageId: "m-alongside",
    });
  });
});
