import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db/index.ts runs its DDL as an import-time side effect resolved via
// env.ts's DATABASE_PATH read — same isolation as test/email/sync/mailQuery.test.ts:
// point DATABASE_PATH at a fresh temp file before anything pulls db/index.ts in.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-unsubscribe-store-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const {
  listBulkSenders,
  newestMessageFromSender,
  newestMessageFromSenderInAccount,
  persistMessageHeaders,
} = await import("../../../src/email/unsubscribe/store.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function seedContact(overrides: {
  address: string;
  displayName?: string;
  kind?: "person" | "bulk";
  messageCount?: number;
  lastContactAt?: string;
  accounts?: string[];
}): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      INSERT INTO contacts (
        address, display_name, kind, category, category_source, gist, accounts,
        message_count, sent_count, last_contact_at, input_hash, created_at, updated_at
      ) VALUES (@address, @displayName, @kind, 'other', 'auto', '', @accounts,
                @messageCount, 0, @lastContactAt, '', @createdAt, @updatedAt)
    `)
    .run({
      address: overrides.address,
      displayName: overrides.displayName ?? "",
      kind: overrides.kind ?? "person",
      accounts: JSON.stringify(overrides.accounts ?? []),
      messageCount: overrides.messageCount ?? 0,
      lastContactAt: overrides.lastContactAt ?? now,
      createdAt: now,
      updatedAt: now,
    });
}

function seedMessage(opts: {
  accountId: string;
  providerMessageId: string;
  from: string;
  date: string;
}): void {
  applySyncPage(opts.accountId, {
    upserts: [
      {
        providerMessageId: opts.providerMessageId,
        providerThreadId: `thread-${opts.providerMessageId}`,
        subject: "Newsletter",
        from: opts.from,
        to: ["owner@example.com"],
        cc: [],
        date: opts.date,
        snippet: "",
        bodyText: "",
        isFromMe: false,
        isUnread: false,
        labels: [],
      },
    ],
    deletes: [],
    cursor: `seed-${opts.providerMessageId}`,
    hasMore: false,
  });
}

describe("listBulkSenders", () => {
  it("returns only kind='bulk' contacts, decoding the accounts JSON column", () => {
    seedContact({
      address: "news@bulk-store-test.com",
      displayName: "Newsletter Co",
      kind: "bulk",
      messageCount: 3,
      lastContactAt: "2026-06-01T00:00:00.000Z",
      accounts: ["acct-a", "acct-b"],
    });
    seedContact({ address: "friend@bulk-store-test.com", kind: "person" });

    const senders = listBulkSenders();
    const addresses = senders.map((s) => s.address);
    expect(addresses).toContain("news@bulk-store-test.com");
    expect(addresses).not.toContain("friend@bulk-store-test.com");

    const found = senders.find((s) => s.address === "news@bulk-store-test.com");
    expect(found).toMatchObject({
      displayName: "Newsletter Co",
      messageCount: 3,
      lastContactAt: "2026-06-01T00:00:00.000Z",
      accounts: ["acct-a", "acct-b"],
    });
  });
});

describe("newestMessageFromSender / newestMessageFromSenderInAccount", () => {
  const address = "digest@sender-store-test.com";

  beforeAll(() => {
    seedMessage({
      accountId: "acct-store-1",
      providerMessageId: "msg-store-old",
      from: `Digest <${address}>`,
      date: "2026-05-01T00:00:00.000Z",
    });
    seedMessage({
      accountId: "acct-store-2",
      providerMessageId: "msg-store-new",
      from: address,
      date: "2026-05-05T00:00:00.000Z",
    });
    // A different sender whose address is a substring of the target — must
    // never match the LIKE-based lookup above.
    seedMessage({
      accountId: "acct-store-1",
      providerMessageId: "msg-store-decoy",
      from: `Not Digest <not-${address}>`,
      date: "2026-05-06T00:00:00.000Z",
    });
  });

  it("finds the newest message across accounts, by an angle-bracket or bare from_addr match", () => {
    const row = newestMessageFromSender(address);
    expect(row?.providerMessageId).toBe("msg-store-new");
    expect(row?.accountId).toBe("acct-store-2");
  });

  it("scopes the lookup to one account", () => {
    const row = newestMessageFromSenderInAccount(address, "acct-store-1");
    expect(row?.providerMessageId).toBe("msg-store-old");
  });

  it("returns null when the account has no message from this sender", () => {
    expect(newestMessageFromSenderInAccount(address, "acct-store-does-not-exist")).toBeNull();
  });

  it("is case-insensitive on the address", () => {
    const row = newestMessageFromSender(address.toUpperCase());
    expect(row?.providerMessageId).toBe("msg-store-new");
  });

  it("returns null for a sender with no mirrored message at all", () => {
    expect(newestMessageFromSender("nobody@sender-store-test.com")).toBeNull();
  });

  it("never matches a from_addr that merely contains the address as a substring", () => {
    // Every row returned above must be the real sender, never msg-store-decoy.
    const row = newestMessageFromSender(address);
    expect(row?.providerMessageId).not.toBe("msg-store-decoy");
  });
});

describe("persistMessageHeaders", () => {
  it("writes the raw header value and post flag when a header was found", () => {
    seedMessage({
      accountId: "acct-store-persist",
      providerMessageId: "msg-persist-1",
      from: "sender@persist-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    persistMessageHeaders("acct-store-persist", "msg-persist-1", {
      listUnsubscribe: "<https://persist-test.com/unsub>",
      listUnsubscribePost: true,
    });

    const row = newestMessageFromSenderInAccount("sender@persist-test.com", "acct-store-persist");
    expect(row?.listUnsubscribe).toBe("<https://persist-test.com/unsub>");
    expect(row?.listUnsubscribePost).toBe(1);
  });

  it("writes '' (not null) when no header was found, so it's known-absent, not unknown", () => {
    seedMessage({
      accountId: "acct-store-persist",
      providerMessageId: "msg-persist-2",
      from: "plain@persist-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    persistMessageHeaders("acct-store-persist", "msg-persist-2", {});

    const row = newestMessageFromSenderInAccount("plain@persist-test.com", "acct-store-persist");
    expect(row?.listUnsubscribe).toBe("");
    expect(row?.listUnsubscribePost).toBe(0);
  });
});
