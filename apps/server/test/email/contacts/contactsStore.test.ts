import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SyncMessage } from "../../../src/email/sync/syncProviders.js";

// db/index.ts runs its DDL as an import-time side effect and resolves its
// path through env.ts's DATABASE_PATH read, also at import time — same
// pattern as test/email/enrich/enrichStore.test.ts: point DATABASE_PATH at a
// fresh temp file before anything pulls db/index.ts in, then import
// everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-contacts-store-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { deriveContacts, getContact, listContacts, setContactCategory } = await import(
  "../../../src/email/contacts/contactsStore.js"
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

describe("deriveContacts: aggregation and normalization", () => {
  const acct = "acct-agg";

  it("normalizes a 'Name <addr>' sender into a lowercased address and captures the name", () => {
    seed(acct, [
      message({
        providerMessageId: "m-alice-1",
        providerThreadId: "t-alice",
        from: "Alice Smith <Alice@Example.com>",
        to: ["owner@example.com"],
        date: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const contact = getContact("alice@example.com");
    expect(contact).not.toBeNull();
    expect(contact?.displayName).toBe("Alice Smith");
    expect(contact?.messageCount).toBe(1);
    expect(contact?.sentCount).toBe(0);
    expect(contact?.accounts).toEqual([acct]);
  });

  it("keeps the longest name seen across multiple messages ('best' name)", () => {
    seed(acct, [
      message({
        providerMessageId: "m-alice-2",
        providerThreadId: "t-alice",
        from: "alice@example.com", // bare, no name this time
        to: ["owner@example.com"],
        date: "2026-02-02T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const contact = getContact("alice@example.com");
    // The bare occurrence must not clobber the fuller name already captured.
    expect(contact?.displayName).toBe("Alice Smith");
    expect(contact?.messageCount).toBe(2);
    expect(contact?.lastContactAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("counts an outbound recipient as a contact with sentCount, not messageCount from inbound", () => {
    seed(acct, [
      message({
        providerMessageId: "m-bob-1",
        providerThreadId: "t-bob",
        from: "owner@example.com",
        to: ["Bob Jones <bob@example.com>"],
        isFromMe: true,
        date: "2026-02-03T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const contact = getContact("bob@example.com");
    expect(contact).toMatchObject({
      displayName: "Bob Jones",
      messageCount: 1,
      sentCount: 1,
    });
  });

  it("unions accounts across every connected account the address corresponds on", () => {
    seed("acct-second", [
      message({
        providerMessageId: "m-bob-second",
        providerThreadId: "t-bob-second",
        from: "Bob Jones <bob@example.com>",
        to: ["owner2@example.com"],
        date: "2026-02-04T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const contact = getContact("bob@example.com");
    expect(contact?.accounts.slice().sort()).toEqual(["acct-agg", "acct-second"]);
  });

  it("returns 0 and leaves rows untouched on a re-run with no new mail (idempotent)", () => {
    const before = getContact("alice@example.com");
    const touched = deriveContacts();
    expect(touched).toBe(0);
    expect(getContact("alice@example.com")).toEqual(before);
  });

  it("never overwrites kind/category/gist/enrichment fields while aggregates keep changing", () => {
    // Simulate a completed enrichment on bob@example.com.
    sqlite
      .prepare(
        "UPDATE contacts SET kind = 'bulk', category = 'service_vendor', gist = 'newsletter', model = 'test-model', enriched_at = ? WHERE address = 'bob@example.com'",
      )
      .run(new Date().toISOString());

    // New mail for the same address forces the aggregate to change again.
    seed(acct, [
      message({
        providerMessageId: "m-bob-2",
        providerThreadId: "t-bob",
        from: "owner@example.com",
        to: ["Bob Jones <bob@example.com>"],
        isFromMe: true,
        date: "2026-02-05T00:00:00.000Z",
      }),
    ]);
    const touched = deriveContacts();
    expect(touched).toBeGreaterThan(0);

    const contact = getContact("bob@example.com");
    // messageCount so far: 1 from the earlier outbound test + 1 inbound-sender
    // occurrence from the "unions accounts" test + this one outbound message.
    expect(contact?.messageCount).toBe(3);
    expect(contact?.sentCount).toBe(2);
    // Untouched by aggregation:
    expect(contact?.kind).toBe("bulk");
    expect(contact?.category).toBe("service_vendor");
    expect(contact?.gist).toBe("newsletter");
    expect(contact?.model).toBe("test-model");
  });
});

describe("deriveContacts: own-address exclusion", () => {
  const acct = "acct-owner";

  it("excludes an address that is from_addr on from-me rows and never on an inbound row, even when self-addressed", () => {
    seed(acct, [
      // Ordinary outbound mail — from_addr is the account's own address.
      message({
        providerMessageId: "m-own-1",
        providerThreadId: "t-own-1",
        from: "owner3@example.com",
        to: ["carol@example.com"],
        isFromMe: true,
        date: "2026-03-01T00:00:00.000Z",
      }),
      // A self-cc: the owner's own address also shows up as a to_addrs
      // recipient of a from-me row — must NOT be enough to create a contact.
      message({
        providerMessageId: "m-own-2",
        providerThreadId: "t-own-2",
        from: "owner3@example.com",
        to: ["owner3@example.com"],
        isFromMe: true,
        date: "2026-03-02T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    expect(getContact("owner3@example.com")).toBeNull();
    // The genuine recipient of the first message is unaffected.
    expect(getContact("carol@example.com")).not.toBeNull();
  });

  it("keeps an address as a real contact once it is also seen as an inbound sender", () => {
    seed(acct, [
      // shared@example.com sends outbound-looking mail (from-me) ...
      message({
        providerMessageId: "m-shared-out",
        providerThreadId: "t-shared-out",
        from: "shared@example.com",
        to: ["dana@example.com"],
        isFromMe: true,
        date: "2026-03-03T00:00:00.000Z",
      }),
      // ... but also genuinely emails the owner inbound — so it is a real
      // correspondent, not the owner's own identity.
      message({
        providerMessageId: "m-shared-in",
        providerThreadId: "t-shared-in",
        from: "shared@example.com",
        to: ["owner3@example.com"],
        isFromMe: false,
        date: "2026-03-04T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const contact = getContact("shared@example.com");
    expect(contact).not.toBeNull();
    expect(contact?.messageCount).toBe(1);
    expect(contact?.sentCount).toBe(0);
  });
});

describe("listContacts and setContactCategory", () => {
  const acct = "acct-crud";

  it("filters by kind, category and a display-name/address query", () => {
    seed(acct, [
      message({
        providerMessageId: "m-erin-1",
        providerThreadId: "t-erin",
        from: "Erin Query <erin@example.com>",
        to: ["owner4@example.com"],
        date: "2026-04-01T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    expect(listContacts({ q: "erin" }).map((c) => c.address)).toContain("erin@example.com");
    expect(listContacts({ q: "no-such-name" }).map((c) => c.address)).not.toContain(
      "erin@example.com",
    );
    expect(listContacts({ kind: "person" }).map((c) => c.address)).toContain("erin@example.com");
    expect(listContacts({ kind: "bulk" }).map((c) => c.address)).not.toContain("erin@example.com");
    expect(listContacts({ category: "other" }).map((c) => c.address)).toContain("erin@example.com");
  });

  it("orders results by last_contact_at, newest first", () => {
    seed(acct, [
      message({
        providerMessageId: "m-frank-1",
        providerThreadId: "t-frank",
        from: "frank@example.com",
        to: ["owner4@example.com"],
        date: "2026-04-10T00:00:00.000Z",
      }),
    ]);
    deriveContacts();

    const addresses = listContacts({}).map((c) => c.address);
    expect(addresses.indexOf("frank@example.com")).toBeLessThan(
      addresses.indexOf("erin@example.com"),
    );
  });

  it("setContactCategory pins category_source to 'user' and persists", () => {
    const updated = setContactCategory("erin@example.com", "client_business");
    expect(updated).toMatchObject({ category: "client_business", categorySource: "user" });
    expect(getContact("erin@example.com")).toMatchObject({
      category: "client_business",
      categorySource: "user",
    });
  });

  it("returns null for an address with no contact row", () => {
    expect(setContactCategory("nobody@example.com", "other")).toBeNull();
  });
});
