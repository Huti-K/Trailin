import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The agent home through its public seams: a real boot init against scratch
 * folders (the skills migration is where a regression would destroy user
 * data), then the skills API on a real Fastify app.
 */

let home: typeof import("../../src/storage/home/agentHome.js");
let appModule: typeof import("../../src/app.js");
let app: Awaited<ReturnType<typeof appModule.buildApp>>;
let legacySkills: string;
let legacyLibrary: string;
let legacyHome: string;

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "trailin-home-test-"));
  legacySkills = await mkdtemp(join(tmpdir(), "trailin-legacy-skills-"));
  legacyLibrary = await mkdtemp(join(tmpdir(), "trailin-legacy-library-"));
  legacyHome = await mkdtemp(join(tmpdir(), "trailin-legacy-home-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Trailin");
  process.env.LEGACY_AGENT_HOME_PATH = legacyHome;
  process.env.SKILLS_PATH = legacySkills;
  process.env.LIBRARY_PATH = legacyLibrary;
  process.env.DATABASE_PATH = join(scratch, "test.db");
  home = await import("../../src/storage/home/agentHome.js");
  appModule = await import("../../src/app.js");
  app = await appModule.buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe("agent home", () => {
  it("migrates a legacy skills folder into the home, converting to frontmatter", async () => {
    await writeFile(
      join(legacySkills, "reply-fast.md"),
      "Antwortet knapp auf Terminanfragen\n\nSchreibe zwei Sätze, bestätige den Termin.\n",
      "utf8",
    );
    await home.initAgentHome();

    const migrated = await readFile(join(home.skillsDir(), "reply-fast.md"), "utf8");
    expect(migrated).toBe(
      "---\ndescription: Antwortet knapp auf Terminanfragen\n---\n\nSchreibe zwei Sätze, bestätige den Termin.\n",
    );
    // The source folder is gone; a second init is a no-op on the steady state.
    await expect(readdir(legacySkills)).rejects.toThrow();
    await home.initAgentHome();
    expect(await readFile(join(home.skillsDir(), "reply-fast.md"), "utf8")).toBe(migrated);
  });

  it("moves a legacy ~/Trailin home (memory/skills/knowledge) into the current home", async () => {
    for (const sub of ["memory", "skills", "knowledge"]) {
      await mkdir(join(legacyHome, sub), { recursive: true });
    }
    await writeFile(join(legacyHome, "memory", "greeting.md"), "Grüßt mit Vornamen.\n", "utf8");
    await writeFile(
      join(legacyHome, "skills", "persona.md"),
      "---\ndescription: X\n---\n\nY.\n",
      "utf8",
    );
    await writeFile(join(legacyHome, "knowledge", "note.md"), "# Note\n", "utf8");

    await home.initAgentHome();

    expect(await readFile(join(home.memoryDir(), "greeting.md"), "utf8")).toBe(
      "Grüßt mit Vornamen.\n",
    );
    expect(await readFile(join(home.skillsDir(), "persona.md"), "utf8")).toBe(
      "---\ndescription: X\n---\n\nY.\n",
    );
    expect(await readFile(join(home.knowledgeDir(), "note.md"), "utf8")).toBe("# Note\n");
    // The legacy home is emptied and removed; a second init is a no-op.
    await expect(readdir(legacyHome)).rejects.toThrow();
    await home.initAgentHome();
  });

  it("round-trips a skill through the API and stores it with frontmatter", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/skills/Follow Up",
      payload: {
        description: "Nachfassen bei stillen Leads",
        instructions: "Frage freundlich nach.",
      },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/skills" });
    const skills = list.json<{ name: string; description: string }[]>();
    const followUp = skills.find((s) => s.name === "follow-up");
    expect(followUp?.description).toBe("Nachfassen bei stillen Leads");

    const onDisk = await readFile(join(home.skillsDir(), "follow-up.md"), "utf8");
    expect(onDisk.startsWith("---\n")).toBe(true);
  });

  it("exports a legacy memories table into files and remaps voice ids", async () => {
    const { sqlite } = await import("../../src/db/index.js");
    const settings = await import("../../src/db/settings.js");
    // The shipped base schema step still creates this table on a fresh db;
    // recreate it as an upgrade-in-progress db would have it, with rows.
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL,
        account_id TEXT, contact_id TEXT, used_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
    );
    sqlite
      .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "old-uuid-1",
        "Der Vermieter heißt Herr Maier.",
        "agent",
        "acc-1",
        null,
        3,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    await settings.patchAccountVoice("acc-1", () => ({
      accountId: "acc-1",
      styleMemoryIds: ["old-uuid-1", "never-existed"],
    }));

    await home.initAgentHome();

    const file = await readFile(
      join(home.memoryDir(), "der-vermieter-heißt-herr-maier.md"),
      "utf8",
    );
    expect(file).toContain("source: agent");
    expect(file).toContain("account: acc-1");
    expect(file).toContain("usedCount: 3");
    expect(file.endsWith("Der Vermieter heißt Herr Maier.\n")).toBe(true);
    // Remapped where known; ids the table never held pass through untouched.
    const voices = await settings.getAccountVoices();
    expect(voices.find((v) => v.accountId === "acc-1")?.styleMemoryIds).toEqual([
      "der-vermieter-heißt-herr-maier",
      "never-existed",
    ]);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get(),
    ).toBeUndefined();
    await home.initAgentHome();
  });

  it("moves legacy library files into knowledge/", async () => {
    // A previous init already emptied and removed the legacy folder; a legacy
    // folder reappearing with content is exactly the re-run case.
    await mkdir(legacyLibrary, { recursive: true });
    await writeFile(join(legacyLibrary, "expose.md"), "# Exposé Musterstraße 1\n", "utf8");
    await home.initAgentHome();
    expect(await readFile(join(home.knowledgeDir(), "expose.md"), "utf8")).toBe(
      "# Exposé Musterstraße 1\n",
    );
    await expect(readdir(legacyLibrary)).rejects.toThrow();
  });

  it("confines paths to a folder and expands tildes", () => {
    const dir = home.skillsDir();
    expect(home.resolveWithin(dir, "a.md")).toBe(join(dir, "a.md"));
    expect(home.resolveWithin(dir, ".")).toBe(dir);
    expect(home.resolveWithin(dir, "../outside.md")).toBeNull();
    expect(home.resolveWithin(dir, "/etc/passwd")).toBeNull();
    expect(home.resolveWithin(dir, "~/anything")).toBeNull();
  });
});
