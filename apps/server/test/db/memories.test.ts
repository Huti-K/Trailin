import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// db/index.ts runs its DDL as an import-time side effect against env.ts's
// DATABASE_PATH read, also at import time — same pattern as
// test/db/draftStore.test.ts — so this suite gets its own scratch database.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-memories-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { closeDb } = await import("../../src/db/index.js");
const { createMemory, updateMemory, listMemories } = await import("../../src/db/memories.js");

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

describe("createMemory — scope validation", () => {
  it("rejects an account AND contact scope at once", async () => {
    await expect(createMemory("x", "user", "acct-1", "anna@firm.de")).rejects.toThrow(
      /both an account and a contact/,
    );
  });

  it("accepts an account-only scope", async () => {
    const { entry } = await createMemory("Acct-only fact", "user", "acct-2", null);
    expect(entry.accountId).toBe("acct-2");
    expect(entry.contactId).toBeNull();
  });

  it("accepts a contact-only scope, normalizing the address", async () => {
    const { entry } = await createMemory("Contact-only fact", "user", null, "  Anna@Firm.DE  ");
    expect(entry.accountId).toBeNull();
    expect(entry.contactId).toBe("anna@firm.de");
  });

  it("defaults to fully global when neither scope is given", async () => {
    const { entry } = await createMemory("Global fact", "user");
    expect(entry.accountId).toBeNull();
    expect(entry.contactId).toBeNull();
  });

  it("treats an empty-string scope as no scope on either axis", async () => {
    const { entry } = await createMemory("Empty-string axes fact", "user", "", "juno@example.com");
    expect(entry.accountId).toBeNull();
    expect(entry.contactId).toBe("juno@example.com");
  });
});

describe("createMemory — dedup per scope", () => {
  it("dedups identical content within the same account scope", async () => {
    const first = await createMemory("Dedup account fact", "user", "acct-dedup", null);
    const second = await createMemory("Dedup account fact.", "user", "acct-dedup", null);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it("dedups identical content within the same contact scope", async () => {
    const first = await createMemory("Dedup contact fact", "user", null, "bob@example.com");
    const second = await createMemory("Dedup contact fact", "user", null, "bob@example.com");
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it("does not dedup the same content across different contacts", async () => {
    const forBob = await createMemory("Shared wording", "user", null, "cross-a@example.com");
    const forCarol = await createMemory("Shared wording", "user", null, "cross-b@example.com");
    expect(forCarol.created).toBe(true);
    expect(forCarol.entry.id).not.toBe(forBob.entry.id);
  });

  it("does not dedup the same content between a global and a contact-scoped entry", async () => {
    const global = await createMemory("Global vs scoped wording", "user", null, null);
    const scoped = await createMemory("Global vs scoped wording", "user", null, "dana@example.com");
    expect(scoped.created).toBe(true);
    expect(scoped.entry.id).not.toBe(global.entry.id);
  });
});

describe("updateMemory — scope transitions", () => {
  it("keeps the current scope when both accountId and contactId are omitted", async () => {
    const { entry } = await createMemory("Keep-scope fact", "user", "acct-keep", null);
    const updated = await updateMemory(entry.id, "Keep-scope fact, edited");
    expect(updated?.accountId).toBe("acct-keep");
    expect(updated?.contactId).toBeNull();
  });

  it("moves an account-scoped entry to a contact scope in one call", async () => {
    const { entry } = await createMemory("Move-scope fact", "user", "acct-move", null);
    const updated = await updateMemory(entry.id, "Move-scope fact", null, "erin@example.com");
    expect(updated?.accountId).toBeNull();
    expect(updated?.contactId).toBe("erin@example.com");
  });

  it("setting one axis with the other omitted moves the scope, clearing the old axis", async () => {
    const { entry } = await createMemory("Omit-move fact", "user", null, "frank@example.com");
    // accountId set, contactId omitted — under the one-scope rule this can only
    // mean "move to the account", so the contact axis clears rather than
    // surviving into a rejected both-axes state.
    const updated = await updateMemory(entry.id, "Omit-move fact", "acct-move-2");
    expect(updated?.accountId).toBe("acct-move-2");
    expect(updated?.contactId).toBeNull();
  });

  it("rejects an explicit account AND contact scope at once", async () => {
    const { entry } = await createMemory("Reject-move fact", "user", null, "frida@example.com");
    await expect(
      updateMemory(entry.id, "Reject-move fact", "acct-reject", "frida@example.com"),
    ).rejects.toThrow(/both an account and a contact/);
  });

  it("clears the contact scope back to global with an explicit null", async () => {
    const { entry } = await createMemory("Clear-scope fact", "user", null, "gina@example.com");
    const updated = await updateMemory(entry.id, "Clear-scope fact", undefined, null);
    expect(updated?.accountId).toBeNull();
    expect(updated?.contactId).toBeNull();
  });

  it("normalizes the contact address on update", async () => {
    const { entry } = await createMemory("Normalize fact", "user");
    const updated = await updateMemory(entry.id, "Normalize fact", null, "  Henry@Corp.COM  ");
    expect(updated?.contactId).toBe("henry@corp.com");
  });
});

describe("listMemories", () => {
  it("carries contactId through to every listed entry", async () => {
    const { entry } = await createMemory("Listed contact fact", "user", null, "ida@example.com");
    const all = await listMemories();
    const found = all.find((m) => m.id === entry.id);
    expect(found?.contactId).toBe("ida@example.com");
  });
});
