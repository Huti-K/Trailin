import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedAccount } from "@trailin/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

// db/index.ts runs its DDL as an import-time side effect resolved via
// env.ts's DATABASE_PATH read — same isolation as the other unsubscribe
// tests and test/email/sync/mailQuery.test.ts.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-unsubscribe-resolve-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

// resolve.ts's listNewsletterSenders calls pipedream/connect.js's
// listAccounts — stub it the way test/pipedream/mcp.test.ts stubs the same
// module, spreading the actual implementation so nothing else it exports
// breaks.
let accountsForList: ConnectedAccount[] = [];
vi.mock("../../../src/pipedream/connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/pipedream/connect.js")>();
  return { ...actual, listAccounts: async () => accountsForList };
});

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { registerSyncProvider } = await import("../../../src/email/sync/syncProviders.js");
const { persistMessageHeaders } = await import("../../../src/email/unsubscribe/store.js");
const { listNewsletterSenders, resolveAccountUnsubscribe } = await import(
  "../../../src/email/unsubscribe/resolve.js"
);

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

// Two fake apps standing in for "Gmail-like" (headers always known at sync
// time, no lazy capability) and "Outlook-like" (never known at sync time,
// lazy capability provided).
const NO_CAPABILITY_APP = "test-nocap-app";
const CAPABILITY_APP = "test-cap-app";

const fetchMessageHeadersMock =
  vi.fn<
    (
      account: ConnectedAccount,
      providerMessageId: string,
    ) => Promise<{ listUnsubscribe?: string; listUnsubscribePost?: boolean }>
  >();

registerSyncProvider(NO_CAPABILITY_APP, {
  fetchChanges: async () => ({ upserts: [], deletes: [], cursor: "x", hasMore: false }),
});
registerSyncProvider(CAPABILITY_APP, {
  fetchChanges: async () => ({ upserts: [], deletes: [], cursor: "x", hasMore: false }),
  fetchMessageHeaders: (account, providerMessageId) =>
    fetchMessageHeadersMock(account, providerMessageId),
});

function account(id: string, app: string): ConnectedAccount {
  return {
    id,
    app,
    appName: app,
    name: `${id}@example.com`,
    healthy: true,
    createdAt: "2026-01-01",
  };
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

function seedContact(overrides: {
  address: string;
  kind?: "person" | "bulk";
  lastContactAt?: string;
  accounts?: string[];
}): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      INSERT INTO contacts (
        address, display_name, kind, category, category_source, gist, accounts,
        message_count, sent_count, last_contact_at, input_hash, created_at, updated_at
      ) VALUES (@address, '', @kind, 'other', 'auto', '', @accounts, 1, 0, @lastContactAt, '', @createdAt, @updatedAt)
    `)
    .run({
      address: overrides.address,
      kind: overrides.kind ?? "bulk",
      accounts: JSON.stringify(overrides.accounts ?? []),
      lastContactAt: overrides.lastContactAt ?? now,
      createdAt: now,
      updatedAt: now,
    });
}

describe("resolveAccountUnsubscribe", () => {
  it("classifies directly from an already-known header, without touching the provider", async () => {
    const acc = account("acct-resolve-known", NO_CAPABILITY_APP);
    seedMessage({
      accountId: acc.id,
      providerMessageId: "msg-known",
      from: "news@resolve-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    persistMessageHeaders(acc.id, "msg-known", {
      listUnsubscribe: "<https://resolve-test.com/unsub>",
      listUnsubscribePost: true,
    });

    const result = await resolveAccountUnsubscribe("news@resolve-test.com", acc);
    expect(result.info).toEqual({ state: "one_click" });
    expect(result.oneClickUrl).toBe("https://resolve-test.com/unsub");
    expect(fetchMessageHeadersMock).not.toHaveBeenCalled();
  });

  it("reports state none for a sender with no mirrored message in this account", async () => {
    const acc = account("acct-resolve-empty", NO_CAPABILITY_APP);
    const result = await resolveAccountUnsubscribe("nobody@resolve-test.com", acc);
    expect(result.info).toEqual({ state: "none" });
  });

  it("reports state none (not unknown) for a null header on a provider with no lazy capability", async () => {
    const acc = account("acct-resolve-nocap", NO_CAPABILITY_APP);
    seedMessage({
      accountId: acc.id,
      providerMessageId: "msg-nocap",
      from: "plain@resolve-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    const result = await resolveAccountUnsubscribe("plain@resolve-test.com", acc);
    expect(result.info).toEqual({ state: "none" });
    expect(fetchMessageHeadersMock).not.toHaveBeenCalled();
  });

  it("lazily fetches and persists headers for a null header on a provider with the capability", async () => {
    fetchMessageHeadersMock.mockReset();
    fetchMessageHeadersMock.mockResolvedValue({
      listUnsubscribe: "<https://lazy-test.com/unsub>",
      listUnsubscribePost: true,
    });
    const acc = account("acct-resolve-cap", CAPABILITY_APP);
    seedMessage({
      accountId: acc.id,
      providerMessageId: "msg-cap",
      from: "lazy@resolve-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    const result = await resolveAccountUnsubscribe("lazy@resolve-test.com", acc);
    expect(result.info).toEqual({ state: "one_click" });
    expect(fetchMessageHeadersMock).toHaveBeenCalledTimes(1);

    // Persisted — a second call must not fetch again.
    const again = await resolveAccountUnsubscribe("lazy@resolve-test.com", acc);
    expect(again.info).toEqual({ state: "one_click" });
    expect(fetchMessageHeadersMock).toHaveBeenCalledTimes(1);
  });

  it("persists '' when the lazy fetch finds no header, resolving to state none", async () => {
    fetchMessageHeadersMock.mockReset();
    fetchMessageHeadersMock.mockResolvedValue({});
    const acc = account("acct-resolve-cap-empty", CAPABILITY_APP);
    seedMessage({
      accountId: acc.id,
      providerMessageId: "msg-cap-empty",
      from: "quiet@resolve-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    const result = await resolveAccountUnsubscribe("quiet@resolve-test.com", acc);
    expect(result.info).toEqual({ state: "none" });

    const again = await resolveAccountUnsubscribe("quiet@resolve-test.com", acc);
    expect(again.info).toEqual({ state: "none" });
    expect(fetchMessageHeadersMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a lazy-fetch failure instead of reporting a silent 'unknown'", async () => {
    fetchMessageHeadersMock.mockReset();
    fetchMessageHeadersMock.mockRejectedValue(new Error("graph unavailable"));
    const acc = account("acct-resolve-cap-fail", CAPABILITY_APP);
    seedMessage({
      accountId: acc.id,
      providerMessageId: "msg-cap-fail",
      from: "flaky@resolve-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    await expect(resolveAccountUnsubscribe("flaky@resolve-test.com", acc)).rejects.toThrow(
      "graph unavailable",
    );
  });
});

describe("listNewsletterSenders", () => {
  it("returns an empty list when there are no bulk contacts", async () => {
    accountsForList = [];
    expect(await listNewsletterSenders()).toEqual([]);
  });

  it("resolves a mix of already-known and lazily-resolved bulk senders", async () => {
    fetchMessageHeadersMock.mockReset();
    fetchMessageHeadersMock.mockResolvedValue({
      listUnsubscribe: "<https://bulk-lazy.com/unsub>",
      listUnsubscribePost: true,
    });

    const knownAcc = account("acct-bulk-known", NO_CAPABILITY_APP);
    const lazyAcc = account("acct-bulk-lazy", CAPABILITY_APP);
    accountsForList = [knownAcc, lazyAcc];

    seedMessage({
      accountId: knownAcc.id,
      providerMessageId: "msg-bulk-known",
      from: "known@bulk-list-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    persistMessageHeaders(knownAcc.id, "msg-bulk-known", {
      listUnsubscribe: "<https://bulk-list-test.com/unsub>",
    });
    seedContact({ address: "known@bulk-list-test.com", accounts: [knownAcc.id] });

    seedMessage({
      accountId: lazyAcc.id,
      providerMessageId: "msg-bulk-lazy",
      from: "lazy@bulk-list-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    seedContact({ address: "lazy@bulk-list-test.com", accounts: [lazyAcc.id] });

    const senders = await listNewsletterSenders();
    const known = senders.find((s) => s.address === "known@bulk-list-test.com");
    const lazy = senders.find((s) => s.address === "lazy@bulk-list-test.com");

    expect(known?.unsubscribe.state).toBe("browse");
    expect(lazy?.unsubscribe.state).toBe("one_click");
  });

  it("caps lazy header fetches at the N=10 per-request budget, leaving the rest unknown", async () => {
    fetchMessageHeadersMock.mockReset();
    fetchMessageHeadersMock.mockResolvedValue({
      listUnsubscribe: "<https://budget-test.com/unsub>",
      listUnsubscribePost: true,
    });

    const SENDER_COUNT = 11;
    const accounts: ConnectedAccount[] = [];
    for (let i = 0; i < SENDER_COUNT; i++) {
      const acc = account(`acct-budget-${i}`, CAPABILITY_APP);
      accounts.push(acc);
      seedMessage({
        accountId: acc.id,
        providerMessageId: `msg-budget-${i}`,
        from: `sender-${i}@budget-test.com`,
        date: "2026-05-01T00:00:00.000Z",
      });
      seedContact({ address: `sender-${i}@budget-test.com`, accounts: [acc.id] });
    }
    accountsForList = accounts;

    const senders = await listNewsletterSenders();
    const budgetSenders = senders.filter((s) => s.address.endsWith("@budget-test.com"));
    expect(budgetSenders).toHaveLength(SENDER_COUNT);

    const resolved = budgetSenders.filter((s) => s.unsubscribe.state === "one_click");
    const stillUnknown = budgetSenders.filter((s) => s.unsubscribe.state === "unknown");
    expect(resolved).toHaveLength(10);
    expect(stillUnknown).toHaveLength(1);
    expect(fetchMessageHeadersMock).toHaveBeenCalledTimes(10);
  });
});
