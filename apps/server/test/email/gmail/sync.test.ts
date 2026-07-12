import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedAccount } from "@trailin/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

// db/index.ts runs its DDL as an import-time side effect resolved via
// env.ts's DATABASE_PATH read — same isolation as test/email/sync/mailQuery.test.ts:
// point DATABASE_PATH at a fresh temp file before anything pulls db/index.ts
// in, then import everything dynamically.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-gmail-sync-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// gmailSyncProvider drives every fetch through proxyRequest — stub it at the
// same boundary test/email/sync/syncEngine.test.ts and
// test/agent/accounts.test.ts stub listAccounts, instead of hitting
// Pipedream's proxy for real.
const proxyRequestMock =
  vi.fn<
    (
      accountId: string,
      method: string,
      url: string,
      opts?: { params?: Record<string, string> },
    ) => Promise<unknown>
  >();
vi.mock("../../../src/pipedream/connect.js", () => ({
  proxyRequest: (...args: Parameters<typeof proxyRequestMock>) => proxyRequestMock(...args),
}));

const { sqlite } = await import("../../../src/db/index.js");
const { applySyncPage } = await import("../../../src/email/sync/mailStore.js");
const { gmailSyncProvider } = await import("../../../src/email/gmail/sync.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function account(id: string): ConnectedAccount {
  return { id, app: "gmail", appName: "Gmail", name: id, healthy: true, createdAt: "2026-01-01" };
}

interface GmailHeader {
  name: string;
  value: string;
}

function fullMessage(id: string, headers: GmailHeader[]) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    internalDate: "1700000000000",
    snippet: "",
    payload: { headers },
  };
}

const withUnsub = fullMessage("m-with-unsub", [
  { name: "Subject", value: "Newsletter" },
  {
    name: "List-Unsubscribe",
    value: "<mailto:unsub@example.com>, <https://example.com/unsub>",
  },
  { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
]);
const withUnsubNoPost = fullMessage("m-with-unsub-no-post", [
  { name: "Subject", value: "Digest" },
  { name: "List-Unsubscribe", value: "<mailto:digest-unsub@example.com>" },
]);
const withoutUnsub = fullMessage("m-without-unsub", [{ name: "Subject", value: "Plain message" }]);

proxyRequestMock.mockImplementation(async (_accountId, _method, url) => {
  if (url === `${GMAIL_API}/profile`) return { historyId: "100" };
  if (url === `${GMAIL_API}/messages`) {
    return { messages: [withUnsub, withUnsubNoPost, withoutUnsub].map((m) => ({ id: m.id })) };
  }
  if (url === `${GMAIL_API}/messages/${withUnsub.id}`) return withUnsub;
  if (url === `${GMAIL_API}/messages/${withUnsubNoPost.id}`) return withUnsubNoPost;
  if (url === `${GMAIL_API}/messages/${withoutUnsub.id}`) return withoutUnsub;
  throw new Error(`unexpected proxyRequest url: ${url}`);
});

describe("gmailSyncProvider List-Unsubscribe capture", () => {
  it("carries the header pair onto SyncMessage, omits them when absent, and mailStore persists both cases", async () => {
    const acct = account("acct-list-unsub");
    const page = await gmailSyncProvider.fetchChanges(acct, null, {
      backfillDays: 30,
      pageSize: 10,
    });

    const withUnsubMsg = page.upserts.find((m) => m.providerMessageId === withUnsub.id);
    const withUnsubNoPostMsg = page.upserts.find((m) => m.providerMessageId === withUnsubNoPost.id);
    const withoutUnsubMsg = page.upserts.find((m) => m.providerMessageId === withoutUnsub.id);

    expect(withUnsubMsg?.listUnsubscribe).toBe(
      "<mailto:unsub@example.com>, <https://example.com/unsub>",
    );
    expect(withUnsubMsg?.listUnsubscribePost).toBe(true);

    // List-Unsubscribe present without List-Unsubscribe-Post: the header
    // pair is still captured, but the one-click flag reads false rather than
    // being omitted (only a fully absent List-Unsubscribe omits both fields).
    expect(withUnsubNoPostMsg?.listUnsubscribe).toBe("<mailto:digest-unsub@example.com>");
    expect(withUnsubNoPostMsg?.listUnsubscribePost).toBe(false);

    expect(withoutUnsubMsg?.listUnsubscribe).toBeUndefined();
    expect(withoutUnsubMsg?.listUnsubscribePost).toBeUndefined();

    applySyncPage(acct.id, page);

    const rows = sqlite
      .prepare(
        `SELECT id, list_unsubscribe AS listUnsubscribe, list_unsubscribe_post AS listUnsubscribePost
         FROM mail_messages WHERE account_id = ?`,
      )
      .all(acct.id) as {
      id: string;
      listUnsubscribe: string | null;
      listUnsubscribePost: number | null;
    }[];

    const withUnsubRow = rows.find((r) => r.id === `${acct.id}:${withUnsub.id}`);
    const withUnsubNoPostRow = rows.find((r) => r.id === `${acct.id}:${withUnsubNoPost.id}`);
    const withoutUnsubRow = rows.find((r) => r.id === `${acct.id}:${withoutUnsub.id}`);

    expect(withUnsubRow?.listUnsubscribe).toBe(
      "<mailto:unsub@example.com>, <https://example.com/unsub>",
    );
    expect(withUnsubRow?.listUnsubscribePost).toBe(1);

    expect(withUnsubNoPostRow?.listUnsubscribe).toBe("<mailto:digest-unsub@example.com>");
    expect(withUnsubNoPostRow?.listUnsubscribePost).toBe(0);

    expect(withoutUnsubRow?.listUnsubscribe).toBeNull();
    expect(withoutUnsubRow?.listUnsubscribePost).toBeNull();
  });
});
