import { cp, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryEntry } from "@trailin/shared";
import { env } from "../../core/env.js";
import { moduleLogger } from "../../core/logger.js";
import { writeFileAtomic } from "../../core/utils/atomicFile.js";
import { sqlite } from "../../db/index.js";
import {
  deleteSetting,
  getAccountVoices,
  getSetting,
  patchAccountVoice,
} from "../../db/settings.js";
import { allocateMemoryId, writeMemoryEntryFile } from "../memories/store.js";
import { getAgentHomeDir, knowledgeDir, memoryDir, resolveFolder, skillsDir } from "./agentHome.js";
import { serializeFrontmatter } from "./frontmatter.js";

/**
 * One-shot boot migrations into the agent home. Each detects its steady
 * state (source folder or table absent) and no-ops, so a crash at any point
 * re-runs cleanly on the next boot. These are the deliberate exception to
 * "data upgrades live in schema steps": schema steps are SQL-only, and the
 * data's destination here is the filesystem.
 */

const log = moduleLogger("home");

/**
 * Skill files from the pre-home folder (env.skillsPath), converted from the
 * old "line one is the description" layout to frontmatter. Conversion is
 * deterministic, so re-running overwrites identically; each source file is
 * deleted only after its converted copy is in place.
 */
export async function migrateSkillsFolder(): Promise<void> {
  const source = resolve(env.skillsPath);
  const target = skillsDir();
  if (source === target) return;
  let entries: string[];
  try {
    entries = await readdir(source);
  } catch {
    return;
  }
  let moved = 0;
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(join(source, file), "utf8");
    await writeFileAtomic(join(target, file), convertSkillFile(text), 0o644);
    await rm(join(source, file));
    moved += 1;
  }
  await rmdir(source).catch(() => {});
  if (moved > 0) log.info({ moved, target }, "migrated skills into the agent home");
}

/**
 * The pre-home `memories` table, exported as one file per row and then
 * dropped. Raw SQL against a table the drizzle schema no longer declares —
 * this migration is the one thing allowed to know it existed. Rows are read
 * in (created_at, id) order so id allocation is deterministic: a re-run after
 * a crash overwrites each file with identical content before reaching the
 * drop. Voice learns store memory ids in the account.voices setting, so those
 * are remapped before the table goes.
 */
export async function migrateMemoriesTable(): Promise<void> {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .get();
  if (!table) return;

  interface Row {
    id: string;
    content: string;
    source: string;
    account_id: string | null;
    contact_id: string | null;
    used_count: number;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
  }
  const rows = sqlite.prepare("SELECT * FROM memories ORDER BY created_at, id").all() as Row[];

  const idMap = new Map<string, string>();
  const taken = new Set<string>();
  for (const row of rows) {
    const content = row.content.trim();
    if (!content) continue;
    const entry: MemoryEntry = {
      id: allocateMemoryId(content, taken),
      content,
      source: row.source === "agent" ? "agent" : "user",
      accountId: row.account_id,
      contactId: row.contact_id,
      usedCount: row.used_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    taken.add(entry.id);
    idMap.set(row.id, entry.id);
    await writeMemoryEntryFile(entry);
  }

  for (const voice of await getAccountVoices()) {
    const ids = voice.styleMemoryIds ?? [];
    const mapped = ids.map((id) => idMap.get(id) ?? id);
    if (mapped.every((id, i) => id === ids[i])) continue;
    await patchAccountVoice(voice.accountId, (existing) => ({
      ...(existing ?? voice),
      styleMemoryIds: mapped,
    }));
  }

  sqlite.exec("DROP TABLE memories");
  if (rows.length > 0) log.info({ exported: idMap.size }, "migrated memories into the agent home");
}

/** The setting that once held a user-chosen library folder; only this migration still knows it. */
const LEGACY_LIBRARY_FOLDER_KEY = "library.folder";

/**
 * Library files from pre-home locations into the knowledge folder. The
 * default/desktop folder (env.libraryPath) is MOVED — rename preserves
 * mtimes, so existing index rows reconcile as unchanged on the next scan. A
 * folder the user explicitly pointed the app at is COPIED and left in place:
 * the migration never empties a folder the user chose for other purposes.
 */
export async function migrateLibraryFolder(): Promise<void> {
  const target = knowledgeDir();
  const defaultSource = resolveFolder(env.libraryPath);
  await moveContentsInto(defaultSource, target);

  const saved = await getSetting(LEGACY_LIBRARY_FOLDER_KEY);
  if (saved === undefined) return;
  const chosen = resolveFolder(saved);
  if (chosen !== target && chosen !== defaultSource) {
    const copied = await copyContentsInto(chosen, target);
    if (copied > 0) {
      log.info(
        { from: chosen, copied, target },
        "copied the chosen library folder into the agent home (originals left in place)",
      );
    }
  }
  await deleteSetting(LEGACY_LIBRARY_FOLDER_KEY);
}

/**
 * The pre-relocation agent home (default ~/Trailin). Its memory/, skills/ and
 * knowledge/ contents move into the current home; no-ops once that folder is
 * the current home or has been emptied.
 */
export async function migrateLegacyHome(): Promise<void> {
  const legacy = resolveFolder(env.legacyAgentHomePath);
  if (legacy === getAgentHomeDir()) return;
  await moveContentsInto(join(legacy, "memory"), memoryDir());
  await moveContentsInto(join(legacy, "skills"), skillsDir());
  await moveContentsInto(join(legacy, "knowledge"), knowledgeDir());
  await rmdir(legacy).catch(() => {});
}

/** Move every visible entry of `source` into `target` (skip name collisions), then drop `source` if emptied. */
async function moveContentsInto(source: string, target: string): Promise<void> {
  if (source === target) return;
  let entries: string[];
  try {
    entries = await readdir(source);
  } catch {
    return;
  }
  let moved = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const from = join(source, name);
    const to = join(target, name);
    if (await exists(to)) {
      log.warn({ name }, "not migrating library entry: the knowledge folder already has one");
      continue;
    }
    try {
      await rename(from, to);
    } catch {
      // Another filesystem (EXDEV) — copy with timestamps, then remove.
      await cp(from, to, { recursive: true, preserveTimestamps: true });
      await rm(from, { recursive: true, force: true });
    }
    moved += 1;
  }
  await rmdir(source).catch(() => {});
  if (moved > 0) log.info({ moved, target }, "migrated files into the agent home");
}

/** Copy every visible entry of `source` into `target`, skipping collisions; returns the copy count. */
async function copyContentsInto(source: string, target: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(source);
  } catch {
    return 0;
  }
  let copied = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const to = join(target, name);
    if (await exists(to)) continue;
    await cp(join(source, name), to, { recursive: true, preserveTimestamps: true });
    copied += 1;
  }
  return copied;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Old format: line 1 = description, rest = instructions. Already-converted files pass through. */
function convertSkillFile(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.startsWith("---\n")) return `${normalized}\n`;
  const firstBreak = normalized.indexOf("\n");
  const description = firstBreak === -1 ? normalized : normalized.slice(0, firstBreak).trim();
  const instructions = firstBreak === -1 ? "" : normalized.slice(firstBreak).trim();
  return serializeFrontmatter({ description }, instructions);
}
