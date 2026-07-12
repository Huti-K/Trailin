import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailThread } from "@trailin/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db/index.ts (pulled in transitively by app.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — so, same as
// test/routes/search.test.ts, point DATABASE_PATH at a fresh temp file
// before anything imports app.ts, rather than share a worker-wide database
// with other test files.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-drafts-route-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { buildApp } = await import("../../src/app.js");
const { applySyncPage } = await import("../../src/email/sync/mailStore.js");
const { createDraftSnapshot, markDraftStatus } = await import("../../src/db/draftStore.js");

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

describe("GET /api/threads/:accountId/:threadId — served from the mailbox mirror", () => {
  const accountId = "acct-thread-route";
  const providerThreadId = "thread-route-1";

  beforeAll(() => {
    applySyncPage(accountId, {
      upserts: [
        {
          providerMessageId: "msg-route-1",
          providerThreadId,
          subject: "Route thread",
          from: "alice@example.com",
          to: ["bob@example.com"],
          cc: [],
          date: "2026-05-01T00:00:00.000Z",
          snippet: "First message snippet",
          bodyText: "First message body.",
          isFromMe: false,
          isUnread: false,
          labels: [],
        },
        {
          providerMessageId: "msg-route-2",
          providerThreadId,
          subject: "Route thread",
          from: "bob@example.com",
          to: ["alice@example.com"],
          cc: ["carol@example.com"],
          date: "2026-05-02T00:00:00.000Z",
          snippet: "Second message snippet",
          bodyText: "Second message body.",
          isFromMe: true,
          isUnread: false,
          labels: [],
        },
      ],
      deletes: [],
      cursor: "seed",
      hasMore: false,
    });
  });

  it("404s for a thread id the mirror has never seen", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${accountId}/no-such-thread`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; requestId: string };
    expect(typeof body.error).toBe("string");
    expect(typeof body.requestId).toBe("string");
  });

  it("404s when the thread exists but under a different account", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/some-other-account/${providerThreadId}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("maps every message's from/to/cc/date/body, oldest first, cc omitted when empty", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${accountId}/${providerThreadId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EmailThread;
    expect(body.messages).toHaveLength(2);

    const [first, second] = body.messages;
    expect(first).toEqual({
      from: "alice@example.com",
      to: ["bob@example.com"],
      date: "2026-05-01T00:00:00.000Z",
      body: "First message body.",
    });
    expect(first && "cc" in first).toBe(false);

    expect(second).toEqual({
      from: "bob@example.com",
      to: ["alice@example.com"],
      cc: ["carol@example.com"],
      date: "2026-05-02T00:00:00.000Z",
      body: "Second message body.",
    });
  });

  it("excludeMessageId drops just that one message by provider message id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${accountId}/${providerThreadId}?excludeMessageId=msg-route-1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EmailThread;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ from: "bob@example.com" });
  });

  it("leaves the thread untouched when excludeMessageId matches nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${accountId}/${providerThreadId}?excludeMessageId=not-a-real-message-id`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EmailThread;
    expect(body.messages).toHaveLength(2);
  });
});

describe("GET /api/drafts/:accountId/:draftId/status — served from the snapshot store", () => {
  const accountId = "acct-status-route";

  it("404s for a draft with no snapshot (not agent-written)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/drafts/${accountId}/untracked-draft/status`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports the recorded fate, including the sent message id", async () => {
    await createDraftSnapshot({
      accountId,
      providerDraftId: "draft-status-1",
      subject: "Status route",
      to: ["anna@example.com"],
      signature: null,
      body: "Body.",
    });

    const open = await app.inject({
      method: "GET",
      url: `/api/drafts/${accountId}/draft-status-1/status`,
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ status: "open" });

    await markDraftStatus(accountId, "draft-status-1", "sent", "sent-msg-9");
    const sent = await app.inject({
      method: "GET",
      url: `/api/drafts/${accountId}/draft-status-1/status`,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ status: "sent", sentMessageId: "sent-msg-9" });
  });

  it("scopes the lookup to the account", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/drafts/some-other-account/draft-status-1/status",
    });
    expect(res.statusCode).toBe(404);
  });
});
