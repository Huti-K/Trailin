import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The file-backed memory store through the real API: entries are markdown
 * files in the agent home whose names follow their content, and the folder
 * itself is a public interface (hand-dropped files count).
 */

let home: typeof import("../../src/storage/home/agentHome.js");
let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;

interface Entry {
  id: string;
  content: string;
  source: string;
  accountId: string | null;
  contactId: string | null;
}

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "trailin-memories-test-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Trailin");
  process.env.DATABASE_PATH = join(scratch, "test.db");
  home = await import("../../src/storage/home/agentHome.js");
  await home.ensureAgentHome();
  app = await (await import("../../src/app.js")).buildApp();
});

afterAll(async () => {
  await app?.close();
});

async function post(content: string, scope: Partial<Entry> = {}): Promise<Entry> {
  const res = await app.inject({
    method: "POST",
    url: "/api/memories",
    payload: { content, ...scope },
  });
  expect(res.statusCode).toBe(200);
  return res.json<Entry>();
}

async function list(): Promise<Entry[]> {
  return (await app.inject({ method: "GET", url: "/api/memories" })).json<Entry[]>();
}

describe("memories", () => {
  it("stores an entry as a slug-named markdown file", async () => {
    const entry = await post("Der Kunde bevorzugt Besichtigungen am Vormittag.");
    expect(entry.id).toBe("der-kunde-bevorzugt-besichtigungen-am-vormittag");
    expect(await readdir(home.memoryDir())).toContain(`${entry.id}.md`);
  });

  it("dedups within one scope but allows the same fact in another", async () => {
    await post("Signatur endet mit Beste Grüße.");
    await post("Signatur endet mit Beste Grüße.");
    expect((await list()).filter((e) => e.content.startsWith("Signatur"))).toHaveLength(1);

    const scoped = await post("Signatur endet mit Beste Grüße.", { accountId: "acc-1" });
    expect(scoped.accountId).toBe("acc-1");
    expect((await list()).filter((e) => e.content.startsWith("Signatur"))).toHaveLength(2);
  });

  it("rejects empty and oversized content as 400", async () => {
    for (const content of ["   ", "x".repeat(301)]) {
      const res = await app.inject({ method: "POST", url: "/api/memories", payload: { content } });
      expect(res.statusCode).toBe(400);
    }
  });

  it("moves scope on update, clearing the other axis, and renames on content change", async () => {
    const entry = await post("Frau Weber duzt man nicht.", { contactId: "Weber@Example.com" });
    expect(entry.contactId).toBe("weber@example.com");

    const res = await app.inject({
      method: "PUT",
      url: `/api/memories/${entry.id}`,
      payload: { content: "Frau Weber wird gesiezt.", accountId: "acc-2" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<Entry>();
    expect(updated.accountId).toBe("acc-2");
    expect(updated.contactId).toBeNull();
    expect(updated.id).toBe("frau-weber-wird-gesiezt");
    const files = await readdir(home.memoryDir());
    expect(files).toContain("frau-weber-wird-gesiezt.md");
    expect(files).not.toContain(`${entry.id}.md`);
  });

  it("deletes an entry's file", async () => {
    const entry = await post("Wegwerfnotiz für den Löschtest.");
    const res = await app.inject({ method: "DELETE", url: `/api/memories/${entry.id}` });
    expect(res.statusCode).toBe(200);
    expect(await readdir(home.memoryDir())).not.toContain(`${entry.id}.md`);
  });

  it("treats a hand-dropped bare markdown file as a global user memory", async () => {
    await writeFile(
      join(home.memoryDir(), "handnotiz.md"),
      "Der Steuerberater heißt Schulz.\n",
      "utf8",
    );
    const entry = (await list()).find((e) => e.id === "handnotiz");
    expect(entry?.content).toBe("Der Steuerberater heißt Schulz.");
    expect(entry?.source).toBe("user");
    expect(entry?.accountId).toBeNull();
    expect(entry?.contactId).toBeNull();
  });
});
