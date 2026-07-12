import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedAccount, NewsletterSender, UnsubscribeResult } from "@trailin/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// db/index.ts (pulled in transitively by app.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — same isolation as
// test/routes/waiting.test.ts: point DATABASE_PATH at a fresh temp file
// before anything imports app.ts.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-newsletters-route-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

const gmailAccount: ConnectedAccount = {
  id: "acct-nl-gmail",
  app: "gmail",
  appName: "Gmail",
  name: "gmail@example.com",
  healthy: true,
  createdAt: "2026-01-01",
};
const outlookAccount: ConnectedAccount = {
  id: "acct-nl-outlook",
  app: "microsoft_outlook",
  appName: "Outlook",
  name: "outlook@example.com",
  healthy: true,
  createdAt: "2026-01-01",
};

const accountsForList: ConnectedAccount[] = [gmailAccount, outlookAccount];
const proxyRequestMock =
  vi.fn<
    (
      accountId: string,
      method: string,
      url: string,
      opts?: { params?: Record<string, string> },
    ) => Promise<unknown>
  >();

// pipedreamConfigured() gates both routes; listAccounts() resolves the
// account for POST and the account/provider map for GET; proxyRequest is
// what outlookSyncProvider.fetchMessageHeaders calls under the hood — stub
// all three the way test/pipedream/mcp.test.ts stubs this module.
vi.mock("../../src/pipedream/connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pipedream/connect.js")>();
  return {
    ...actual,
    pipedreamConfigured: async () => true,
    listAccounts: async () => accountsForList,
    proxyRequest: (...args: Parameters<typeof proxyRequestMock>) => proxyRequestMock(...args),
  };
});

const { buildApp } = await import("../../src/app.js");
const { sqlite } = await import("../../src/db/index.js");
const { applySyncPage } = await import("../../src/email/sync/mailStore.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  // app.close() runs closeDb() (see app.ts's onClose hook), so the sqlite
  // handle underneath is already released by the time this returns.
  await app.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

afterEach(() => {
  proxyRequestMock.mockReset();
  vi.unstubAllGlobals();
});

function seedContact(overrides: {
  address: string;
  displayName?: string;
  lastContactAt?: string;
  accounts?: string[];
}): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      INSERT INTO contacts (
        address, display_name, kind, category, category_source, gist, accounts,
        message_count, sent_count, last_contact_at, input_hash, created_at, updated_at
      ) VALUES (@address, @displayName, 'bulk', 'other', 'auto', '', @accounts,
                1, 0, @lastContactAt, '', @createdAt, @updatedAt)
    `)
    .run({
      address: overrides.address,
      displayName: overrides.displayName ?? "",
      accounts: JSON.stringify(overrides.accounts ?? []),
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

describe("GET /api/newsletters", () => {
  it("classifies a Gmail sender directly from its already-known headers", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-nl-gmail-oneclick",
      from: "promo@newsletters-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 1 WHERE id = ?",
      )
      .run(
        "<https://newsletters-route-test.com/unsub>",
        `${gmailAccount.id}:msg-nl-gmail-oneclick`,
      );
    seedContact({
      address: "promo@newsletters-route-test.com",
      displayName: "Promo Co",
      accounts: [gmailAccount.id],
    });

    const res = await app.inject({ method: "GET", url: "/api/newsletters" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NewsletterSender[];
    const sender = body.find((s) => s.address === "promo@newsletters-route-test.com");
    expect(sender?.unsubscribe).toEqual({ state: "one_click" });
    expect(sender?.displayName).toBe("Promo Co");
  });

  it("lazily settles a Gmail row with unchecked headers to none, exactly once", async () => {
    // NULL header columns on a Gmail row mean "mirrored before header capture
    // existed" — the lazy fetch settles it to '' so it never re-fetches.
    proxyRequestMock.mockResolvedValue({ payload: { headers: [] } });
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-nl-gmail-none",
      from: "plain@newsletters-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    seedContact({ address: "plain@newsletters-route-test.com", accounts: [gmailAccount.id] });

    const res = await app.inject({ method: "GET", url: "/api/newsletters" });
    const body = res.json() as NewsletterSender[];
    const sender = body.find((s) => s.address === "plain@newsletters-route-test.com");
    expect(sender?.unsubscribe.state).toBe("none");
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);

    proxyRequestMock.mockClear();
    const again = await app.inject({ method: "GET", url: "/api/newsletters" });
    const settled = (again.json() as NewsletterSender[]).find(
      (s) => s.address === "plain@newsletters-route-test.com",
    );
    expect(settled?.unsubscribe.state).toBe("none");
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("prefers the sender's newest message WITH a header over a newer one without", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-nl-older-header",
      from: "mixed@newsletters-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-nl-newer-plain",
      from: "mixed@newsletters-route-test.com",
      date: "2026-05-02T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 1 WHERE id = ?",
      )
      .run(
        "<https://newsletters-route-test.com/mixed-unsub>",
        `${gmailAccount.id}:msg-nl-older-header`,
      );
    // The newer message was already checked and has no header ('' = settled).
    sqlite
      .prepare("UPDATE mail_messages SET list_unsubscribe = '' WHERE id = ?")
      .run(`${gmailAccount.id}:msg-nl-newer-plain`);
    seedContact({ address: "mixed@newsletters-route-test.com", accounts: [gmailAccount.id] });

    const res = await app.inject({ method: "GET", url: "/api/newsletters" });
    const sender = (res.json() as NewsletterSender[]).find(
      (s) => s.address === "mixed@newsletters-route-test.com",
    );
    expect(sender?.unsubscribe).toEqual({ state: "one_click" });
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("lazily resolves an Outlook sender's headers and persists them for next time", async () => {
    proxyRequestMock.mockResolvedValue({
      internetMessageHeaders: [
        {
          name: "List-Unsubscribe",
          value: "<https://newsletters-route-test.com/outlook-unsub>",
        },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    });
    seedMessage({
      accountId: outlookAccount.id,
      providerMessageId: "msg-nl-outlook-lazy",
      from: "digest@newsletters-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    seedContact({ address: "digest@newsletters-route-test.com", accounts: [outlookAccount.id] });

    const first = await app.inject({ method: "GET", url: "/api/newsletters" });
    const firstSender = (first.json() as NewsletterSender[]).find(
      (s) => s.address === "digest@newsletters-route-test.com",
    );
    expect(firstSender?.unsubscribe).toEqual({ state: "one_click" });
    expect(proxyRequestMock).toHaveBeenCalledWith(
      outlookAccount.id,
      "get",
      `${GRAPH_API}/messages/msg-nl-outlook-lazy`,
      { params: { $select: "internetMessageHeaders" } },
    );

    proxyRequestMock.mockClear();
    const second = await app.inject({ method: "GET", url: "/api/newsletters" });
    const secondSender = (second.json() as NewsletterSender[]).find(
      (s) => s.address === "digest@newsletters-route-test.com",
    );
    expect(secondSender?.unsubscribe).toEqual({ state: "one_click" });
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/newsletters/unsubscribe", () => {
  it("404s for an unknown accountId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "someone@example.com", accountId: "no-such-account" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when the sender has no unsubscribe header at all", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-none",
      from: "quiet@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "quiet@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s (mentioning the link) when only a browse URL exists — mailto and browse are never automated", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-browse",
      from: "browse@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 0 WHERE id = ?",
      )
      .run("<https://unsub-route-test.com/browse>", `${gmailAccount.id}:msg-unsub-browse`);

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "browse@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toContain("https://unsub-route-test.com/browse");
  });

  it("400s for a mailto-only sender", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-mailto",
      from: "mailto-only@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 0 WHERE id = ?",
      )
      .run("<mailto:unsub@unsub-route-test.com>", `${gmailAccount.id}:msg-unsub-mailto`);

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "mailto-only@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs the one-click POST and reports requested on success", async () => {
    seedContact({
      address: "oneclick@unsub-route-test.com",
      accounts: [gmailAccount.id],
    });
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-oneclick",
      from: "oneclick@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 1 WHERE id = ?",
      )
      .run("<https://unsub-route-test.com/oneclick>", `${gmailAccount.id}:msg-unsub-oneclick`);

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "oneclick@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as UnsubscribeResult).toEqual({ ok: true, state: "requested" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://unsub-route-test.com/oneclick");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");

    // A successful request is stamped on the sender's contact row, and the
    // list renders it from there on every later load.
    const row = sqlite
      .prepare("SELECT unsubscribe_requested_at AS at FROM contacts WHERE address = ?")
      .get("oneclick@unsub-route-test.com") as { at: string | null };
    expect(row.at).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/api/newsletters" });
    const sender = (list.json() as NewsletterSender[]).find(
      (s) => s.address === "oneclick@unsub-route-test.com",
    );
    expect(sender?.unsubscribeRequestedAt).toBe(row.at);
  });

  it("a failed one-click request leaves no requested stamp", async () => {
    seedContact({
      address: "failing@unsub-route-test.com",
      accounts: [gmailAccount.id],
    });
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-failing",
      from: "failing@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 1 WHERE id = ?",
      )
      .run("<https://unsub-route-test.com/failing>", `${gmailAccount.id}:msg-unsub-failing`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "failing@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(502);

    const row = sqlite
      .prepare("SELECT unsubscribe_requested_at AS at FROM contacts WHERE address = ?")
      .get("failing@unsub-route-test.com") as { at: string | null };
    expect(row.at).toBeNull();
  });

  it("surfaces a failed one-click request as an upstream error, not a silent success", async () => {
    seedMessage({
      accountId: gmailAccount.id,
      providerMessageId: "msg-unsub-fail",
      from: "willfail@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    sqlite
      .prepare(
        "UPDATE mail_messages SET list_unsubscribe = ?, list_unsubscribe_post = 1 WHERE id = ?",
      )
      .run("<https://unsub-route-test.com/willfail>", `${gmailAccount.id}:msg-unsub-fail`);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "willfail@unsub-route-test.com", accountId: gmailAccount.id },
    });
    expect(res.statusCode).toBe(502);
  });

  it("lazily resolves Outlook headers before deciding, then executes the one-click POST", async () => {
    proxyRequestMock.mockResolvedValue({
      internetMessageHeaders: [
        { name: "List-Unsubscribe", value: "<https://unsub-route-test.com/outlook>" },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    });
    seedMessage({
      accountId: outlookAccount.id,
      providerMessageId: "msg-unsub-outlook-lazy",
      from: "lazyclick@unsub-route-test.com",
      date: "2026-05-01T00:00:00.000Z",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const res = await app.inject({
      method: "POST",
      url: "/api/newsletters/unsubscribe",
      payload: { address: "lazyclick@unsub-route-test.com", accountId: outlookAccount.id },
    });
    expect(res.statusCode).toBe(200);
    expect(proxyRequestMock).toHaveBeenCalled();
  });
});
