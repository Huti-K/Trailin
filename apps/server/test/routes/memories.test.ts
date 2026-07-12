import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

interface MemoryEntryBody {
  id: string;
  content: string;
  accountId: string | null;
  contactId: string | null;
}

describe("memory routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a body that fails schema validation, in the error envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { accountId: 5 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(typeof body.requestId).toBe("string");
  });

  it("creates, lists, updates and deletes a memory", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { content: "Bevorzugt kurze, formelle Antworten" },
    });
    expect(created.statusCode).toBe(200);
    const entry = created.json() as MemoryEntryBody;
    expect(entry.content).toBe("Bevorzugt kurze, formelle Antworten");

    const listed = await app.inject({ method: "GET", url: "/api/memories" });
    expect(listed.statusCode).toBe(200);
    const entries = listed.json() as MemoryEntryBody[];
    expect(entries.some((m) => m.id === entry.id)).toBe(true);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: "Bevorzugt ausführliche Antworten" },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as MemoryEntryBody).content).toBe("Bevorzugt ausführliche Antworten");

    const deleted = await app.inject({ method: "DELETE", url: `/api/memories/${entry.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    const gone = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: "x" },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("creates a contact-scoped memory when the other axis is an explicit JSON null", async () => {
    // The web client always sends both axes, the unused one as null — the
    // schema layer's type coercion must not turn that null into a live "" scope.
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { content: "Explicit-null axes", accountId: null, contactId: "new@nowhere.dev" },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json() as MemoryEntryBody;
    expect(entry.accountId).toBeNull();
    expect(entry.contactId).toBe("new@nowhere.dev");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: "Explicit-null axes", accountId: "acc-1", contactId: null },
    });
    expect(updated.statusCode).toBe(200);
    const updatedEntry = updated.json() as MemoryEntryBody;
    expect(updatedEntry.accountId).toBe("acc-1");
    expect(updatedEntry.contactId).toBeNull();

    await app.inject({ method: "DELETE", url: `/api/memories/${entry.id}` });
  });

  it("rejects creating a memory scoped to both an account and a contact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { content: "both scopes", accountId: "acc-1", contactId: "anna@example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/account and a contact/);
  });

  it("moves scope on update: setting one axis clears the omitted other", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { content: "Bevorzugt förmliche Anrede", contactId: "anna@example.com" },
    });
    const entry = created.json() as MemoryEntryBody;
    expect(entry.contactId).toBe("anna@example.com");

    // contactId omitted, not null — the account move must clear it anyway.
    const moved = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: entry.content, accountId: "acc-1" },
    });
    expect(moved.statusCode).toBe(200);
    const movedEntry = moved.json() as MemoryEntryBody;
    expect(movedEntry.accountId).toBe("acc-1");
    expect(movedEntry.contactId).toBeNull();

    // And back: setting a contact clears the omitted account axis.
    const back = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: entry.content, contactId: "anna@example.com" },
    });
    expect(back.statusCode).toBe(200);
    const backEntry = back.json() as MemoryEntryBody;
    expect(backEntry.accountId).toBeNull();
    expect(backEntry.contactId).toBe("anna@example.com");

    // Sending both non-null is the one still-invalid combination.
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: entry.content, accountId: "acc-1", contactId: "anna@example.com" },
    });
    expect(conflict.statusCode).toBe(400);

    await app.inject({ method: "DELETE", url: `/api/memories/${entry.id}` });
  });
});
