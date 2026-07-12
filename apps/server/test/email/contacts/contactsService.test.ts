import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — same
// pattern as test/email/enrich/enrichStore.test.ts. The active-model check
// inside runContactsCycle is mocked so the cycle always reaches the judge
// seam without needing real LLM credentials configured.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-contacts-service-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

vi.mock("../../../src/llm/registry.js", () => ({
  activeModelConfigured: async () => true,
}));

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { runContactsCycle } = await import("../../../src/email/contacts/contactsService.js");
const { getContact, setContactCategory } = await import(
  "../../../src/email/contacts/contactsStore.js"
);

// contactsLLM.ts's resolveContactsModel also lives behind llm/registry.js,
// so it is never called — runContactsCycle only calls it when there is at
// least one stale candidate, and that path is exercised below with a fake
// model object standing in for its return value.
vi.mock("../../../src/email/contacts/contactsLLM.js", () => ({
  resolveContactsModel: async () => fakeModel,
  judgeContact: async () => {
    throw new Error("judgeContact should never be called directly; tests inject their own judge");
  },
}));

const fakeModel = { id: "test-model" } as unknown as Model<Api>;

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
    subject: "Hello",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    cc: [],
    date: "2026-01-01T00:00:00.000Z",
    snippet: "Hi there",
    bodyText: "Hi there",
    isFromMe: false,
    isUnread: false,
    labels: [],
    ...overrides,
  };
}

function seed(accountId: string, upserts: SyncMessage[]): void {
  applySyncPage(accountId, { upserts, deletes: [], cursor: "seed", hasMore: false });
}

describe("runContactsCycle", () => {
  const acct = "acct-cycle";

  it("judges a newly-derived contact and persists kind/category/gist", async () => {
    seed(acct, [
      message({
        providerMessageId: "m-greta-1",
        providerThreadId: "t-greta",
        from: "Greta Newsletter <greta@example.com>",
        to: ["owner@example.com"],
        date: "2026-05-01T00:00:00.000Z",
      }),
    ]);

    const judge = vi.fn(async () => ({
      kind: "bulk" as const,
      category: "other" as const,
      gist: "a weekly newsletter",
    }));

    const result = await runContactsCycle(judge);
    expect(result.derived).toBeGreaterThan(0);
    expect(result.enriched).toBe(1);
    expect(judge).toHaveBeenCalledTimes(1);

    const contact = getContact("greta@example.com");
    expect(contact).toMatchObject({
      kind: "bulk",
      category: "other",
      categorySource: "auto",
      gist: "a weekly newsletter",
      model: "test-model",
    });
    expect(contact?.enrichedAt).not.toBeNull();
  });

  it("does not re-judge a contact whose recent-message content hasn't changed (hash staleness)", async () => {
    const judge = vi.fn(async () => ({
      kind: "person" as const,
      category: "other" as const,
      gist: "unused",
    }));
    // greta's content is unchanged since the previous cycle judged it —
    // enriched_at should already be current, so the timestamp-based
    // prefilter finds nothing to look at at all.
    const result = await runContactsCycle(judge);
    expect(result.derived).toBe(0);
    expect(result.enriched).toBe(0);
    expect(judge).not.toHaveBeenCalled();

    // Original judgment is untouched.
    expect(getContact("greta@example.com")).toMatchObject({
      kind: "bulk",
      gist: "a weekly newsletter",
    });
  });

  it("re-judges once new mail changes the contact's recent-message hash", async () => {
    seed(acct, [
      message({
        providerMessageId: "m-greta-2",
        providerThreadId: "t-greta",
        from: "Greta Newsletter <greta@example.com>",
        to: ["owner@example.com"],
        subject: "Second issue",
        date: "2026-05-02T00:00:00.000Z",
      }),
    ]);

    const judge = vi.fn(async () => ({
      kind: "bulk" as const,
      category: "other" as const,
      gist: "updated gist",
    }));
    const result = await runContactsCycle(judge);
    expect(result.enriched).toBe(1);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(getContact("greta@example.com")?.gist).toBe("updated gist");
  });

  it("never overwrites a user-set category, but still refreshes kind and gist", async () => {
    seed(acct, [
      message({
        providerMessageId: "m-hank-1",
        providerThreadId: "t-hank",
        from: "Hank Client <hank@example.com>",
        to: ["owner@example.com"],
        date: "2026-05-03T00:00:00.000Z",
      }),
    ]);
    await runContactsCycle(async () => ({
      kind: "person",
      category: "other",
      gist: "first pass",
    }));
    expect(getContact("hank@example.com")).toMatchObject({
      category: "other",
      categorySource: "auto",
    });

    const overridden = setContactCategory("hank@example.com", "client_business");
    expect(overridden).toMatchObject({ category: "client_business", categorySource: "user" });

    // Backdate enriched_at so the staleness prefilter is unambiguous
    // regardless of how many milliseconds this fast test actually took.
    sqlite
      .prepare("UPDATE contacts SET enriched_at = '2020-01-01T00:00:00.000Z' WHERE address = ?")
      .run("hank@example.com");

    // New mail makes hank stale again; the next judgment tries to set a
    // different category, but the user's override must win.
    seed(acct, [
      message({
        providerMessageId: "m-hank-2",
        providerThreadId: "t-hank",
        from: "Hank Client <hank@example.com>",
        to: ["owner@example.com"],
        date: "2026-05-04T00:00:00.000Z",
      }),
    ]);
    const result = await runContactsCycle(async () => ({
      kind: "person",
      category: "personal", // deliberately different from the user's override
      gist: "second pass",
    }));
    expect(result.enriched).toBe(1);

    const contact = getContact("hank@example.com");
    expect(contact?.category).toBe("client_business");
    expect(contact?.categorySource).toBe("user");
    // kind/gist still refresh even though category is pinned.
    expect(contact?.gist).toBe("second pass");
  });

  it("records a failed judgment's error without losing the previous good gist, and backs off retrying it", async () => {
    seed(acct, [
      message({
        providerMessageId: "m-ivy-1",
        providerThreadId: "t-ivy",
        from: "Ivy Flake <ivy@example.com>",
        to: ["owner@example.com"],
        date: "2026-05-05T00:00:00.000Z",
      }),
    ]);
    await runContactsCycle(async () => ({ kind: "person", category: "other", gist: "good gist" }));
    expect(getContact("ivy@example.com")?.gist).toBe("good gist");

    // Backdate enriched_at so the next cycle's staleness prefilter is
    // unambiguous regardless of how many milliseconds this fast test took.
    sqlite
      .prepare("UPDATE contacts SET enriched_at = '2020-01-01T00:00:00.000Z' WHERE address = ?")
      .run("ivy@example.com");

    seed(acct, [
      message({
        providerMessageId: "m-ivy-2",
        providerThreadId: "t-ivy",
        from: "Ivy Flake <ivy@example.com>",
        to: ["owner@example.com"],
        date: "2026-05-06T00:00:00.000Z",
      }),
    ]);
    const failing = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const result = await runContactsCycle(failing);
    expect(result.failed).toBe(1);

    const contact = getContact("ivy@example.com");
    expect(contact?.error).toBe("model unavailable");
    expect(contact?.gist).toBe("good gist"); // stale beats none

    // Immediately re-running must not retry — still inside the backoff window.
    const retry = vi.fn(async () => ({
      kind: "person" as const,
      category: "other" as const,
      gist: "x",
    }));
    await runContactsCycle(retry);
    expect(retry).not.toHaveBeenCalled();
  });
});
