import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// db/index.ts runs its DDL as an import-time side effect against
// env.ts's DATABASE_PATH — point it at a fresh temp file before anything
// imports the store (same pattern as test/routes/drafts.test.ts).
const tempDir = mkdtempSync(join(tmpdir(), "trailin-draft-store-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { db, schema, closeDb } = await import("../../src/db/index.js");
const {
  appendDraftVersion,
  createDraftSnapshot,
  getDraftCardDetails,
  getDraftConversationLinks,
  getDraftStatus,
  linkDraftConversation,
  markDraftStatus,
} = await import("../../src/db/draftStore.js");

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

const ACCOUNT = "acct-store-test";

async function seedSnapshot(providerDraftId: string) {
  await createDraftSnapshot({
    accountId: ACCOUNT,
    providerDraftId,
    providerMessageId: `${providerDraftId}-msg`,
    threadId: "thread-1",
    subject: "Original subject",
    to: ["anna@example.com"],
    cc: ["bob@example.com"],
    signature: "Beste Grüße\nKadim",
    body: "Original body.\n\nBeste Grüße\nKadim",
  });
}

async function versionsOf(providerDraftId: string) {
  const rows = await db.select().from(schema.agentDrafts);
  const row = rows.find((r) => r.accountId === ACCOUNT && r.providerDraftId === providerDraftId);
  if (!row) return [];
  const versions = await db.select().from(schema.agentDraftVersions);
  return versions.filter((v) => v.draftId === row.id).sort((a, b) => a.version - b.version);
}

describe("createDraftSnapshot", () => {
  it("writes the row with status open and an agent-authored version 1", async () => {
    await seedSnapshot("draft-create");

    const status = await getDraftStatus(ACCOUNT, "draft-create");
    expect(status).toEqual({ status: "open" });

    const versions = await versionsOf("draft-create");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      author: "agent",
      subject: "Original subject",
      body: "Original body.\n\nBeste Grüße\nKadim",
    });
  });

  it("getDraftStatus returns null for a draft with no snapshot", async () => {
    expect(await getDraftStatus(ACCOUNT, "never-created")).toBeNull();
  });
});

describe("appendDraftVersion", () => {
  it("carries forward whichever of body/subject the patch omits", async () => {
    await seedSnapshot("draft-versions");

    // A body-only user edit keeps the subject of the latest version.
    expect(
      await appendDraftVersion(ACCOUNT, "draft-versions", "user", { body: "User edit." }),
    ).toBe(true);
    // A subject-only agent rewrite keeps the user-edited body.
    expect(
      await appendDraftVersion(ACCOUNT, "draft-versions", "agent", { subject: "New subject" }),
    ).toBe(true);

    const versions = await versionsOf("draft-versions");
    expect(versions.map((v) => [v.version, v.author, v.subject, v.body])).toEqual([
      [1, "agent", "Original subject", "Original body.\n\nBeste Grüße\nKadim"],
      [2, "user", "Original subject", "User edit."],
      [3, "agent", "New subject", "User edit."],
    ]);
  });

  it("is a no-op returning false when the draft has no snapshot", async () => {
    expect(await appendDraftVersion(ACCOUNT, "untracked", "user", { body: "x" })).toBe(false);
  });
});

describe("getDraftCardDetails", () => {
  it("combines the row's recipients with the latest version's subject and body", async () => {
    await seedSnapshot("draft-card");
    await appendDraftVersion(ACCOUNT, "draft-card", "agent", { body: "Rewritten body." });

    expect(await getDraftCardDetails(ACCOUNT, "draft-card")).toEqual({
      threadId: "thread-1",
      subject: "Original subject",
      to: ["anna@example.com"],
      cc: ["bob@example.com"],
      bcc: [],
      body: "Rewritten body.",
    });
  });

  it("returns null for a draft with no snapshot", async () => {
    expect(await getDraftCardDetails(ACCOUNT, "untracked")).toBeNull();
  });
});

describe("markDraftStatus", () => {
  it("records sent with the provider's message id", async () => {
    await seedSnapshot("draft-sent");
    expect(await markDraftStatus(ACCOUNT, "draft-sent", "sent", "sent-msg-1")).toBe(true);
    expect(await getDraftStatus(ACCOUNT, "draft-sent")).toEqual({
      status: "sent",
      sentMessageId: "sent-msg-1",
    });
  });

  it("records discarded without a message id", async () => {
    await seedSnapshot("draft-discarded");
    expect(await markDraftStatus(ACCOUNT, "draft-discarded", "discarded")).toBe(true);
    expect(await getDraftStatus(ACCOUNT, "draft-discarded")).toEqual({ status: "discarded" });
  });

  it("returns false when the draft has no snapshot", async () => {
    expect(await markDraftStatus(ACCOUNT, "untracked", "sent")).toBe(false);
  });
});

describe("conversation links", () => {
  it("links resolve only while the conversation row still exists", async () => {
    await seedSnapshot("draft-linked");
    await db.insert(schema.conversations).values({
      id: "conv-1",
      title: "Chat that wrote the draft",
      type: "chat",
      createdAt: new Date().toISOString(),
    });

    expect(await linkDraftConversation(ACCOUNT, "draft-linked", "conv-1")).toBe(true);
    expect(await getDraftConversationLinks(["draft-linked", "draft-create"])).toEqual(
      new Map([["draft-linked", "conv-1"]]),
    );

    // A deleted chat degrades to "no link" instead of a dead id.
    await db.delete(schema.conversations);
    expect(await getDraftConversationLinks(["draft-linked"])).toEqual(new Map());
  });

  it("linking an untracked draft is a no-op returning false", async () => {
    expect(await linkDraftConversation(ACCOUNT, "untracked", "conv-1")).toBe(false);
  });

  it("returns an empty map for an empty id list", async () => {
    expect(await getDraftConversationLinks([])).toEqual(new Map());
  });
});
