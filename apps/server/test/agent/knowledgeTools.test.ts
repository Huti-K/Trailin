import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedAccount } from "@trailin/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

// db/index.ts runs its DDL as an import-time side effect resolved via
// env.ts's DATABASE_PATH read — same pattern as test/db/draftStore.test.ts —
// so this suite gets its own scratch database.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-knowledge-tools-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

// buildKnowledgeContext resolves account-scoped memory names via
// fetchAccountNameMap → listAccounts(), same as every other agent-tool suite
// (test/agent/accounts.test.ts, test/agent/briefingTool.test.ts) — stub it
// instead of hitting Pipedream.
const listAccountsMock = vi.fn<() => Promise<ConnectedAccount[]>>();
vi.mock("../../src/pipedream/connect.js", () => ({
  listAccounts: () => listAccountsMock(),
}));

const { db, schema, closeDb } = await import("../../src/db/index.js");
const { createMemory } = await import("../../src/db/memories.js");
const { buildKnowledgeContext, buildKnowledgeTools } = await import(
  "../../src/agent/knowledgeTools.js"
);

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function account(id: string, name: string): ConnectedAccount {
  return { id, app: "gmail", appName: "Gmail", name, healthy: true, createdAt: "2026-01-01" };
}

async function seedContact(
  address: string,
  overrides: Partial<typeof schema.contacts.$inferInsert> = {},
) {
  await db.insert(schema.contacts).values({
    address,
    displayName: "",
    kind: "person",
    category: "other",
    categorySource: "auto",
    gist: "",
    accounts: "[]",
    messageCount: 0,
    sentCount: 0,
    lastContactAt: "",
    inputHash: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const tools = buildKnowledgeTools();
const memorySave = tools.find((t) => t.name === "memory_save");
const memoryUpdate = tools.find((t) => t.name === "memory_update");
if (!memorySave || !memoryUpdate) throw new Error("memory_save/memory_update not registered");

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("buildKnowledgeContext — contact grouping", () => {
  it("returns '' when there is nothing saved", async () => {
    listAccountsMock.mockResolvedValue([]);
    expect(await buildKnowledgeContext()).toBe("");
  });

  it("groups contact-scoped memories after account-scoped ones, using the contacts display name when known", async () => {
    listAccountsMock.mockResolvedValue([account("acct-ctx", "work@example.com")]);
    await seedContact("anna@firm.de", { displayName: "Anna Becker" });

    await createMemory("Global standing fact", "user", null, null);
    await createMemory("Account-only fact", "user", "acct-ctx", null);
    await createMemory("Anna prefers Du", "user", null, "anna@firm.de");

    const context = await buildKnowledgeContext();
    expect(context).toContain("Global standing fact");
    expect(context).toContain("Memory for work@example.com");
    expect(context).toContain("Account-only fact");
    expect(context).toContain("Memory about Anna Becker <anna@firm.de>");
    expect(context).toContain("Anna prefers Du");

    // Account-scoped section precedes the contact-scoped section.
    const accountIdx = context.indexOf("Memory for work@example.com");
    const contactIdx = context.indexOf("Memory about Anna Becker");
    expect(accountIdx).toBeGreaterThan(-1);
    expect(contactIdx).toBeGreaterThan(accountIdx);
  });

  it("falls back to the bare address when the contact has no contacts row", async () => {
    listAccountsMock.mockResolvedValue([]);
    await createMemory("Unknown contact fact", "user", null, "ghost@example.com");
    const context = await buildKnowledgeContext();
    expect(context).toContain("Memory about ghost@example.com");
  });
});

describe("memory_save — contact scope", () => {
  it("describes the contact parameter as scoping to a correspondent instead of an account", () => {
    const params = memorySave.parameters as {
      properties: { contact: { description: string } };
    };
    expect(params.properties.contact.description).toContain(
      "Scope this fact to a specific correspondent — their email address — instead of an account",
    );
  });

  it("saves a contact-scoped memory, using the contacts display name in the confirmation", async () => {
    await seedContact("carla@vendor.com", { displayName: "Carla Diaz" });
    const result = await memorySave.execute("call-1", {
      content: "Always CCs her assistant",
      contact: "Carla@Vendor.com",
    } as never);
    expect(textOf(result)).toContain("Carla Diaz <carla@vendor.com>");
    expect(textOf(result)).toContain("Always CCs her assistant");
  });

  it("rejects passing both account and contact", async () => {
    const result = await memorySave.execute("call-2", {
      content: "x",
      account: "work@example.com",
      contact: "someone@example.com",
    } as never);
    expect(textOf(result)).toContain("not both");
  });
});

describe("memory_update — contact scope", () => {
  it("moves an entry into a contact scope", async () => {
    const { entry } = await createMemory("Movable fact", "user", null, null);
    const result = await memoryUpdate.execute("call-3", {
      id: entry.id,
      content: "Movable fact",
      contact: "dee@example.com",
    } as never);
    expect(textOf(result)).toContain("Memory updated");
    const context = await buildKnowledgeContext();
    expect(context).toContain("Memory about dee@example.com");
  });

  it('"general" on the contact parameter clears the scope back to global', async () => {
    const { entry } = await createMemory("Clearable fact", "user", null, "erin@example.com");
    const result = await memoryUpdate.execute("call-4", {
      id: entry.id,
      content: "Clearable fact",
      contact: "general",
    } as never);
    expect(textOf(result)).toContain("Memory updated");
    const context = await buildKnowledgeContext();
    expect(context).not.toContain("Memory about erin@example.com");
  });
});
