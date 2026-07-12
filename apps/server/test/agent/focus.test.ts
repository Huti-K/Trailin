import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Temp DATABASE_PATH before db/index.ts's import-time DDL (same pattern as
// test/db/draftStore.test.ts).
const tempDir = mkdtempSync(join(tmpdir(), "trailin-focus-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { db, schema, closeDb } = await import("../../src/db/index.js");
const {
  applyConversationFocus,
  clearConversationFocus,
  conversationFocusNote,
  focusFromCard,
  focusFromRefs,
} = await import("../../src/agent/focus.js");

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

async function focusRow(id: string) {
  const rows = await db.select().from(schema.conversations);
  const row = rows.find((r) => r.id === id);
  return row
    ? {
        account: row.focusAccountId,
        thread: row.focusThreadId,
        subject: row.focusThreadSubject,
      }
    : null;
}

describe("focusFromRefs", () => {
  it("follows the last attached ref", () => {
    expect(
      focusFromRefs([
        { threadId: "t1", accountId: "a1", subject: "First" },
        { threadId: "t2", accountId: "a2", subject: "Second" },
      ]),
    ).toEqual({ accountId: "a2", threadId: "t2", subject: "Second" });
  });

  it("is null without refs", () => {
    expect(focusFromRefs(undefined)).toBeNull();
    expect(focusFromRefs([])).toBeNull();
  });
});

describe("focusFromCard", () => {
  const account = { accountId: "a1", name: "work@example.com", app: "gmail" };

  it("thread cards set account + thread", () => {
    expect(
      focusFromCard({
        kind: "email_thread",
        account,
        threadId: "t9",
        subject: "Re: X",
        messages: [],
      }),
    ).toEqual({ accountId: "a1", threadId: "t9", subject: "Re: X" });
  });

  it("draft cards follow the draft's thread", () => {
    expect(
      focusFromCard({
        kind: "email_draft",
        account,
        draft: { draftId: "d1", threadId: "t3", subject: "S", to: ["x@y.z"], body: "b" },
      }),
    ).toEqual({ accountId: "a1", threadId: "t3", subject: "S" });
  });

  it("search hits set the account and clear the thread", () => {
    expect(focusFromCard({ kind: "email_hits", account, hits: [] })).toEqual({
      accountId: "a1",
      threadId: null,
    });
  });

  it("cards without an account never move focus", () => {
    expect(focusFromCard({ kind: "email_hits", hits: [] })).toBeNull();
  });
});

describe("focus writes and the turn note", () => {
  it("last writer wins, manual clear empties everything", async () => {
    await db.insert(schema.conversations).values({
      id: "conv-f1",
      title: "Focus test",
      type: "chat",
      createdAt: new Date().toISOString(),
    });

    await applyConversationFocus("conv-f1", { accountId: "a1", threadId: "t1", subject: "Re: X" });
    expect(await focusRow("conv-f1")).toEqual({ account: "a1", thread: "t1", subject: "Re: X" });

    const note = await conversationFocusNote("conv-f1");
    expect(note).toContain("account a1");
    expect(note).toContain('"Re: X"');

    // An account-wide patch clears the thread part.
    await applyConversationFocus("conv-f1", { accountId: "a2", threadId: null });
    expect(await focusRow("conv-f1")).toEqual({ account: "a2", thread: null, subject: null });
    expect(await conversationFocusNote("conv-f1")).not.toContain("thread");

    // A patch that leaves threadId undefined keeps the thread as is.
    await applyConversationFocus("conv-f1", { accountId: "a1", threadId: "t5", subject: "S5" });
    await applyConversationFocus("conv-f1", { accountId: "a1" });
    expect(await focusRow("conv-f1")).toEqual({ account: "a1", thread: "t5", subject: "S5" });

    await clearConversationFocus("conv-f1");
    expect(await focusRow("conv-f1")).toEqual({ account: null, thread: null, subject: null });
    expect(await conversationFocusNote("conv-f1")).toBe("");
  });

  it("the note is empty for an unknown conversation", async () => {
    expect(await conversationFocusNote("no-such-conversation")).toBe("");
  });
});
