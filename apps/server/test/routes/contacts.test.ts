import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contact, ContactDetail } from "@trailin/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db/index.ts (pulled in transitively by app.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — same pattern as
// test/routes/waiting.test.ts: point DATABASE_PATH at a fresh temp file
// before anything imports app.ts.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-contacts-route-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { buildApp } = await import("../../src/app.js");
const { sqlite } = await import("../../src/db/index.js");
const { applySyncPage } = await import("../../src/email/sync/mailStore.js");
const { deriveContacts } = await import("../../src/email/contacts/contactsStore.js");
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

const ACCOUNT = "acct-contacts-route";

describe("GET /api/contacts", () => {
  beforeAll(() => {
    applySyncPage(ACCOUNT, {
      upserts: [
        {
          providerMessageId: "msg-route-person-1",
          providerThreadId: "thread-route-person",
          subject: "Quarterly numbers",
          from: "Jamie Accountant <jamie@example.com>",
          to: ["owner@example.com"],
          cc: [],
          date: "2026-05-10T00:00:00.000Z",
          snippet: "Here are the numbers",
          bodyText: "Here are the numbers",
          isFromMe: false,
          isUnread: false,
          labels: [],
        },
        {
          providerMessageId: "msg-route-bulk-1",
          providerThreadId: "thread-route-bulk",
          subject: "This week's digest",
          from: "Weekly Digest <digest@example.com>",
          to: ["owner@example.com"],
          cc: [],
          date: "2026-05-09T00:00:00.000Z",
          snippet: "Top stories this week",
          bodyText: "Top stories this week",
          isFromMe: false,
          isUnread: false,
          labels: [],
        },
      ],
      deletes: [],
      cursor: "seed",
      hasMore: false,
    });
    deriveContacts();
    // Stand in for a completed enrichment pass, so kind/category filters
    // have something to distinguish.
    sqlite
      .prepare(
        "UPDATE contacts SET kind = 'bulk', category = 'other', gist = 'weekly digest' WHERE address = 'digest@example.com'",
      )
      .run();
    sqlite
      .prepare(
        "UPDATE contacts SET kind = 'person', category = 'service_vendor', gist = 'your accountant' WHERE address = 'jamie@example.com'",
      )
      .run();
  });

  it("lists every derived contact, newest last_contact_at first", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Contact[];
    const addresses = body.map((c) => c.address);
    expect(addresses).toEqual(expect.arrayContaining(["jamie@example.com", "digest@example.com"]));
    expect(addresses.indexOf("jamie@example.com")).toBeLessThan(
      addresses.indexOf("digest@example.com"),
    );
  });

  it("filters by kind", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts?kind=bulk" });
    const body = res.json() as Contact[];
    expect(body.map((c) => c.address)).toEqual(["digest@example.com"]);
  });

  it("filters by category", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts?category=service_vendor" });
    const body = res.json() as Contact[];
    expect(body.map((c) => c.address)).toEqual(["jamie@example.com"]);
  });

  it("filters by a display-name/address query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts?q=jamie" });
    const body = res.json() as Contact[];
    expect(body.map((c) => c.address)).toEqual(["jamie@example.com"]);
  });

  it("400s on an invalid kind", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts?kind=nonsense" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/contacts/:address", () => {
  const address = "jamie@example.com";

  it("includes up to 15 recent threads, newest first, with enrichment gist when present", async () => {
    saveEnrichment(
      {
        threadId: `${ACCOUNT}:thread-route-person`,
        accountId: ACCOUNT,
        subject: "Quarterly numbers",
        inputHash: "route-hash-1",
        takenAt: new Date().toISOString(),
        messages: [],
      },
      {
        gist: "Sent this quarter's numbers",
        summary: "",
        actionItems: [],
        triage: "fyi",
        urgency: "normal",
        awaitingReply: false,
      },
      "test-model",
    );

    const res = await app.inject({ method: "GET", url: `/api/contacts/${address}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ContactDetail;
    expect(body.address).toBe(address);
    expect(body.category).toBe("service_vendor");
    expect(body.recentThreads).toHaveLength(1);
    expect(body.recentThreads[0]).toMatchObject({
      threadId: "thread-route-person",
      accountId: ACCOUNT,
      subject: "Quarterly numbers",
      gist: "Sent this quarter's numbers",
    });
  });

  it("resolves the address case-insensitively", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts/JAMIE@EXAMPLE.COM" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ContactDetail).address).toBe(address);
  });

  it("404s for an address with no contact row", async () => {
    const res = await app.inject({ method: "GET", url: "/api/contacts/nobody@example.com" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/contacts/:address", () => {
  const address = "jamie@example.com";

  it("sets category and category_source, and the change persists", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${address}`,
      payload: { category: "personal" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ category: "personal", categorySource: "user" });

    const get = await app.inject({ method: "GET", url: `/api/contacts/${address}` });
    expect(get.json()).toMatchObject({ category: "personal", categorySource: "user" });
  });

  it("400s on an invalid category", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${address}`,
      payload: { category: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an address with no contact row", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/contacts/nobody@example.com",
      payload: { category: "other" },
    });
    expect(res.statusCode).toBe(404);
  });
});
