import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db/index.ts (pulled in transitively by app.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — same as test/routes/drafts.test.ts:
// point DATABASE_PATH at a fresh temp file before anything imports app.ts.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-waiting-route-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { buildApp } = await import("../../src/app.js");
const { sqlite } = await import("../../src/db/index.js");
const { applySyncPage } = await import("../../src/email/sync/mailStore.js");
const { saveEnrichment } = await import("../../src/email/enrich/enrichStore.js");

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

describe("POST /api/waiting/:accountId/:threadId/dismiss", () => {
  const accountId = "acct-dismiss-route";
  const providerThreadId = "thread-dismiss-route";

  beforeAll(() => {
    applySyncPage(accountId, {
      upserts: [
        {
          providerMessageId: "msg-dismiss-route-1",
          providerThreadId,
          subject: "Dismiss route thread",
          from: "alice@example.com",
          to: ["owner@example.com"],
          cc: [],
          date: "2026-05-01T00:00:00.000Z",
          snippet: "",
          bodyText: "",
          isFromMe: false,
          isUnread: false,
          labels: [],
        },
      ],
      deletes: [],
      cursor: "seed",
      hasMore: false,
    });
    saveEnrichment(
      {
        threadId: `${accountId}:${providerThreadId}`,
        accountId,
        subject: "Dismiss route thread",
        inputHash: "route-hash-1",
        takenAt: new Date().toISOString(),
        messages: [],
      },
      {
        gist: "",
        summary: "",
        actionItems: [],
        triage: "needs_reply",
        urgency: "normal",
        awaitingReply: false,
      },
      "test-model",
    );
  });

  it("404s for a thread with no enrichment state row", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/waiting/${accountId}/no-such-thread/dismiss`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; requestId: string };
    expect(typeof body.error).toBe("string");
  });

  it("404s for a thread that exists under a different account", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/waiting/some-other-account/${providerThreadId}/dismiss`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("stamps dismissed_hash to the current input_hash and returns ok", async () => {
    const before = sqlite
      .prepare("SELECT dismissed_hash AS dismissedHash FROM mail_thread_state WHERE thread_id = ?")
      .get(`${accountId}:${providerThreadId}`) as { dismissedHash: string | null };
    expect(before.dismissedHash).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: `/api/waiting/${accountId}/${providerThreadId}/dismiss`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const after = sqlite
      .prepare("SELECT dismissed_hash AS dismissedHash FROM mail_thread_state WHERE thread_id = ?")
      .get(`${accountId}:${providerThreadId}`) as { dismissedHash: string | null };
    expect(after.dismissedHash).toBe("route-hash-1");
  });
});
