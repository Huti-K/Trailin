import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// Same DATABASE_PATH isolation dance as matcher.test.ts / enrichStore.test.ts:
// point it at a fresh temp file before anything pulls db/index.ts in.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-learn-extract-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { createDraftSnapshot, markDraftStatus, listUnlearnedSentDrafts } = await import(
  "../../../src/db/draftStore.js"
);
const { listMemories } = await import("../../../src/db/memories.js");
const { runExtractionSweep } = await import("../../../src/email/learn/extractor.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function message(
  overrides: Partial<SyncMessage> & Pick<SyncMessage, "providerMessageId" | "providerThreadId">,
): SyncMessage {
  return {
    subject: "Sent copy",
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

function seedSent(accountId: string, msg: SyncMessage): void {
  applySyncPage(accountId, { upserts: [msg], deletes: [], cursor: "seed", hasMore: false });
}

/** Creates a snapshot, then moves it straight to sent+unlearned via markDraftStatus, as the matcher would. */
async function seedSentSnapshot(input: {
  accountId: string;
  providerDraftId: string;
  signature: string | null;
  draftBody: string;
  sentMessageId: string;
}): Promise<void> {
  await createDraftSnapshot({
    accountId: input.accountId,
    providerDraftId: input.providerDraftId,
    subject: "Subject",
    to: ["them@example.com"],
    signature: input.signature,
    body: input.draftBody,
  });
  await markDraftStatus(input.accountId, input.providerDraftId, "sent", input.sentMessageId);
}

async function neverCalledExtract(): Promise<string[]> {
  throw new Error("extract should not have been called for an identical pair");
}

describe("runExtractionSweep — identical pair", () => {
  it("stamps learned_at without calling the LLM seam or writing a memory, ignoring whitespace differences", async () => {
    const accountId = "acct-extract-identical";
    const providerDraftId = "draft-identical-1";
    const signature = "Best,\nAlice";

    await seedSentSnapshot({
      accountId,
      providerDraftId,
      signature,
      draftBody: "Hello there.\n\nBest,\nAlice",
      sentMessageId: "sent-identical-1",
    });
    // The mirrored copy differs only in whitespace — still "identical" once
    // both sides are whitespace-normalized and the signature is stripped.
    seedSent(
      accountId,
      message({
        providerMessageId: "sent-identical-1",
        providerThreadId: "thread-identical",
        bodyText: "Hello   there.\n\n\nBest,\nAlice",
      }),
    );

    await runExtractionSweep(neverCalledExtract);

    const pending = await listUnlearnedSentDrafts();
    expect(pending.some((p) => p.providerDraftId === providerDraftId)).toBe(false);

    const memories = await listMemories();
    expect(memories.some((m) => m.accountId === accountId)).toBe(false);
  });
});

describe("runExtractionSweep — differing pair", () => {
  it("writes each reported directive as an account-scoped memory and stamps learned_at", async () => {
    const accountId = "acct-extract-differing";
    const providerDraftId = "draft-differing-1";

    await seedSentSnapshot({
      accountId,
      providerDraftId,
      signature: null,
      draftBody: "Hi, please find the report attached. Let me know if you have questions.",
      sentMessageId: "sent-differing-1",
    });
    seedSent(
      accountId,
      message({
        providerMessageId: "sent-differing-1",
        providerThreadId: "thread-differing",
        bodyText: "Hey! Report's attached — shout if anything's unclear.",
      }),
    );

    let receivedAccountName: string | undefined;
    let receivedPairCount: number | undefined;
    await runExtractionSweep(async (input) => {
      receivedAccountName = input.accountName;
      receivedPairCount = input.pairs.length;
      return ['Opens casually ("Hey!") rather than formally.'];
    });

    expect(receivedPairCount).toBe(1);
    expect(receivedAccountName).toBeTruthy();

    const pending = await listUnlearnedSentDrafts();
    expect(pending.some((p) => p.providerDraftId === providerDraftId)).toBe(false);

    const memories = await listMemories();
    const written = memories.find(
      (m) =>
        m.accountId === accountId && m.content === 'Opens casually ("Hey!") rather than formally.',
    );
    expect(written).toBeDefined();
    expect(written?.source).toBe("agent");
  });

  it("stamps learned_at on every pair in the batch even when the seam reports zero directives", async () => {
    const accountId = "acct-extract-empty-directives";
    const providerDraftId = "draft-differing-empty";

    await seedSentSnapshot({
      accountId,
      providerDraftId,
      signature: null,
      draftBody: "Draft body one.",
      sentMessageId: "sent-empty-1",
    });
    seedSent(
      accountId,
      message({
        providerMessageId: "sent-empty-1",
        providerThreadId: "thread-empty",
        bodyText: "Sent body one, quite different.",
      }),
    );

    await runExtractionSweep(async () => []);

    const pending = await listUnlearnedSentDrafts();
    expect(pending.some((p) => p.providerDraftId === providerDraftId)).toBe(false);
  });
});

describe("runExtractionSweep — unresolved sent message", () => {
  it("leaves the pair pending (and never calls the seam) when the mirror hasn't synced the sent message yet", async () => {
    const accountId = "acct-extract-unresolved";
    const providerDraftId = "draft-unresolved-1";

    await seedSentSnapshot({
      accountId,
      providerDraftId,
      signature: null,
      draftBody: "Draft body.",
      sentMessageId: "sent-never-synced",
    });
    // No applySyncPage call — the mirror never sees this provider message id.

    await runExtractionSweep(neverCalledExtract);

    const pending = await listUnlearnedSentDrafts();
    expect(pending.some((p) => p.providerDraftId === providerDraftId)).toBe(true);
  });
});
