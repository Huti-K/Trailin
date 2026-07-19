import { type FSWatcher, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { env } from "../../core/env.js";
import { emitServerEvent } from "../../core/events.js";
import { moduleLogger } from "../../core/logger.js";
import {
  migrateLegacyHome,
  migrateLibraryFolder,
  migrateMemoriesTable,
  migrateSkillsFolder,
} from "./migrate.js";

/**
 * The agent's home folder: a user-browsable directory the agent owns.
 * Project-relative (`agent-home`) by default; the desktop shell points it into
 * Electron's userData. `memory/` holds one markdown file per long-term memory,
 * `skills/` one playbook per skill, `knowledge/` the indexed document drop
 * folder. Everything in it is plain files — editable in any editor, syncable
 * like any folder — so every store re-reads from disk on demand and treats
 * hand-authored files as first-class data.
 */

const log = moduleLogger("home");

/** Expand a leading ~ to the home directory and resolve to an absolute path. */
export function resolveFolder(input: string): string {
  const expanded =
    input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(1)) : input;
  return resolve(expanded);
}

export function getAgentHomeDir(): string {
  return resolveFolder(env.agentHomePath);
}

export function memoryDir(): string {
  return join(getAgentHomeDir(), "memory");
}

export function skillsDir(): string {
  return join(getAgentHomeDir(), "skills");
}

export function knowledgeDir(): string {
  return join(getAgentHomeDir(), "knowledge");
}

/**
 * Resolve a possibly-relative, possibly-~-prefixed path against `dir` and
 * confine it there: returns the absolute path, or null when the result would
 * escape the folder — however the path came to contain traversal segments.
 * `dir` itself is inside.
 */
export function resolveWithin(dir: string, path: string): string | null {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  const absPath = resolve(dir, expanded);
  return absPath === dir || absPath.startsWith(dir + sep) ? absPath : null;
}

/** Create the home folder and its three subfolders; heals a user-deleted tree. */
export async function ensureAgentHome(): Promise<void> {
  for (const dir of [getAgentHomeDir(), memoryDir(), skillsDir(), knowledgeDir()]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Boot entry point: make the folder tree exist, then bring forward any data
 * still living in pre-home locations. Idempotent — every migration detects
 * its steady state and no-ops.
 */
export async function initAgentHome(): Promise<void> {
  await ensureAgentHome();
  await migrateLegacyHome();
  await migrateMemoriesTable();
  await migrateSkillsFolder();
  await migrateLibraryFolder();
  startHomeWatchers();
  log.info({ home: getAgentHomeDir() }, "agent home ready");
}

/**
 * External edits to memory/ and skills/ (Finder, editors, sync) reach the web
 * UI by SSE: one non-recursive watcher per folder, debounce-emitting that
 * folder's topic. The agent needs no plumbing — prompts re-read the folders
 * every turn. knowledge/ is the library scanner's watcher, not ours. On
 * watcher failure, re-ensure the folders and re-arm after a backoff.
 */
const WATCH_DEBOUNCE_MS = 500;
const WATCH_RETRY_MS = 30_000;

let watchers: FSWatcher[] = [];
const emitTimers = new Map<string, NodeJS.Timeout>();
let watcherRetryTimer: NodeJS.Timeout | null = null;

function watchFolder(dir: string, topic: "memories" | "skills"): FSWatcher | null {
  try {
    const watcher = watch(dir, () => {
      const pending = emitTimers.get(topic);
      if (pending) clearTimeout(pending);
      emitTimers.set(
        topic,
        setTimeout(() => {
          emitTimers.delete(topic);
          emitServerEvent(topic);
        }, WATCH_DEBOUNCE_MS),
      );
    });
    // Watchers don't hold the process (or a test run) open by themselves.
    watcher.unref();
    watcher.on("error", (error) => {
      log.warn({ err: error, dir }, `home watcher failed — retrying in ${WATCH_RETRY_MS / 1000}s`);
      watcher.close();
      if (watcherRetryTimer) return;
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        void ensureAgentHome()
          .then(() => startHomeWatchers())
          .catch((err: unknown) => log.error({ err }, "home watcher restart failed"));
      }, WATCH_RETRY_MS);
      watcherRetryTimer.unref();
    });
    return watcher;
  } catch {
    // No folder watching on this platform — the UI refreshes on its own writes.
    return null;
  }
}

export function startHomeWatchers(): void {
  stopHomeWatchers();
  watchers = [watchFolder(memoryDir(), "memories"), watchFolder(skillsDir(), "skills")].filter(
    (w): w is FSWatcher => w !== null,
  );
}

export function stopHomeWatchers(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  for (const timer of emitTimers.values()) clearTimeout(timer);
  emitTimers.clear();
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}
