import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// db/index.ts (pulled in transitively by app.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — same as test/routes/search.test.ts,
// point DATABASE_PATH at a fresh temp file before anything imports app.ts.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-settings-route-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { buildApp } = await import("../../src/app.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

describe("PUT /api/settings/language — validation", () => {
  it("rejects an unsupported language with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/language",
      payload: { language: "klingon" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^language must be one of:/);
  });
});

describe("PUT /api/settings/timezone — validation", () => {
  it("rejects an invalid IANA timezone with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/timezone",
      payload: { timezone: "Not/A_Zone" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("timezone must be a valid IANA timezone");
  });
});

describe("GET/PUT /api/settings/sync-backfill-days", () => {
  it("defaults to the env window", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/sync-backfill-days" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ days: 30 });
  });

  it("persists a new window (Pipedream being unconfigured must not fail the backfill restart)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/sync-backfill-days",
      payload: { days: 90 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ days: 90 });

    const get = await app.inject({ method: "GET", url: "/api/settings/sync-backfill-days" });
    expect(get.json()).toEqual({ days: 90 });
  });

  it("rejects a non-positive or fractional window with 400", async () => {
    for (const days of [0, -5, 1.5]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings/sync-backfill-days",
        payload: { days },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("GET/PUT /api/settings/contact-threads-limit", () => {
  it("defaults to 15", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/contact-threads-limit" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ limit: 15 });
  });

  it("persists a new limit", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/contact-threads-limit",
      payload: { limit: 50 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ limit: 50 });

    const get = await app.inject({ method: "GET", url: "/api/settings/contact-threads-limit" });
    expect(get.json()).toEqual({ limit: 50 });
  });

  it("rejects a non-positive limit with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/contact-threads-limit",
      payload: { limit: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET/PUT /api/settings/write-access", () => {
  it("defaults to no armed accounts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/write-access" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountIds: [] });
  });

  it("dedupes ids on write and persists the deduped list", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/write-access",
      payload: { accountIds: ["a", "b", "a"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ accountIds: ["a", "b"] });

    const get = await app.inject({ method: "GET", url: "/api/settings/write-access" });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ accountIds: ["a", "b"] });
  });

  it("rejects a non-array accountIds with 400, in the error envelope", async () => {
    // A bare string body would be array-coerced by Fastify's default AJV
    // settings (coerceTypes: "array" wraps a scalar as a one-element array),
    // so use a shape coercion can't fix: an object instead of an array.
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/write-access",
      payload: { accountIds: { not: "an array" } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(typeof body.requestId).toBe("string");
  });
});
