import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_MAX_COUNT, MEMORY_MAX_LENGTH, type MemoryEntry } from "@trailin/shared";
import { emitServerEvent } from "../../core/events.js";
import { moduleLogger } from "../../core/logger.js";
import { writeFileAtomic } from "../../core/utils/atomicFile.js";
import { slugify } from "../../core/utils/util.js";
import { memoryDir } from "../home/agentHome.js";
import { parseFrontmatter, serializeFrontmatter } from "../home/frontmatter.js";

/**
 * Long-term memory: small standing facts, one markdown file each in the
 * agent home's memory/ folder. The filename (minus .md) is the entry id and
 * follows the content; scope, source and usage counters live in flat
 * frontmatter, the fact itself is the body. The folder is the source of
 * truth — a bare sentence dropped in by hand is a valid global user memory —
 * and every entry is injected into the agent's system prompt in full, so the
 * length cap keeps each to about a sentence. Single-process, last-writer-wins:
 * interleaved rewrites of one file (use-counter vs edit) are acceptable for a
 * single user.
 */

const log = moduleLogger("memories");

/** Lowercase, whitespace-collapsed, no trailing period; for duplicate detection only. */
function normalizeForDedup(content: string): string {
  const collapsed = content.toLowerCase().replace(/\s+/g, " ").trim();
  return collapsed.replace(/\.$/, "");
}

/** Lowercased, trimmed; matches how contact addresses are normalized everywhere. */
function normalizeContactId(contactId: string): string {
  return contactId.trim().toLowerCase();
}

/** A memory is global (both null), account-scoped, OR contact-scoped; never both. */
function assertSingleScope(accountId: string | null, contactId: string | null): void {
  if (accountId !== null && contactId !== null) {
    throw new Error("memory cannot be scoped to both an account and a contact");
  }
}

function entryPath(id: string): string {
  return join(memoryDir(), `${id}.md`);
}

/** Parse one memory file; null when it has no content or an impossible scope. */
function parseEntry(id: string, text: string, mtime: Date): MemoryEntry | null {
  const { fields, body } = parseFrontmatter(text);
  if (!body) return null;
  const accountId = fields.account || null;
  const contactId = fields.contact ? normalizeContactId(fields.contact) : null;
  if (accountId !== null && contactId !== null) {
    log.warn({ id }, "memory file scoped to both an account and a contact; skipped");
    return null;
  }
  const usedCount = Number.parseInt(fields.usedCount ?? "", 10);
  return {
    id,
    content: body,
    source: fields.source === "agent" ? "agent" : "user",
    accountId,
    contactId,
    usedCount: Number.isNaN(usedCount) ? 0 : usedCount,
    lastUsedAt: fields.lastUsedAt || null,
    createdAt: fields.createdAt || mtime.toISOString(),
    updatedAt: mtime.toISOString(),
  };
}

/** The frontmatter an entry writes back; counters and scope omitted when empty. */
function entryFields(entry: MemoryEntry): Record<string, string> {
  return {
    source: entry.source,
    account: entry.accountId ?? "",
    contact: entry.contactId ?? "",
    createdAt: entry.createdAt,
    usedCount: entry.usedCount > 0 ? String(entry.usedCount) : "",
    lastUsedAt: entry.lastUsedAt ?? "",
  };
}

/** Also the boot migration's writer, so exported: files it creates are exactly the store's shape. */
export async function writeMemoryEntryFile(entry: MemoryEntry): Promise<void> {
  await writeFileAtomic(
    entryPath(entry.id),
    serializeFrontmatter(entryFields(entry), entry.content),
    0o644,
  );
}

export async function listMemories(): Promise<MemoryEntry[]> {
  let files: string[];
  try {
    files = await readdir(memoryDir());
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .map(async (file): Promise<MemoryEntry | null> => {
        const path = join(memoryDir(), file);
        try {
          const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          // macOS readdir can return NFD names; NFC normalization round-trips ids as typed.
          return parseEntry(file.slice(0, -".md".length).normalize("NFC"), text, info.mtime);
        } catch {
          return null;
        }
      }),
  );
  return entries
    .filter((e): e is MemoryEntry => e !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** A filename no existing entry uses: content slug, then -2/-3…; hex fallback for empty slugs. */
export function allocateMemoryId(content: string, taken: Set<string>): string {
  const base = slugify(content) || `memory-${randomUUID().slice(0, 6)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface CreateMemoryResult {
  entry: MemoryEntry;
  /** False when an existing entry already matched and was returned instead. */
  created: boolean;
}

export async function createMemory(
  content: string,
  source: MemoryEntry["source"],
  accountId: string | null = null,
  contactId: string | null = null,
): Promise<CreateMemoryResult> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("memory content must not be empty");
  if (trimmed.length > MEMORY_MAX_LENGTH) {
    throw new Error(`memory content must be at most ${MEMORY_MAX_LENGTH} characters`);
  }
  // An empty string on either axis means "no scope": the route layer's schema
  // coercion can deliver "" where the client sent an explicit null.
  const normalizedAccountId = accountId || null;
  const normalizedContactId = contactId ? normalizeContactId(contactId) : null;
  assertSingleScope(normalizedAccountId, normalizedContactId);

  // Dedup within the same (accountId, contactId) scope only: the same fact may
  // legitimately exist for two accounts, two contacts, or globally and scoped.
  const existing = await listMemories();
  const target = normalizeForDedup(trimmed);
  for (const entry of existing) {
    if (
      entry.accountId === normalizedAccountId &&
      entry.contactId === normalizedContactId &&
      normalizeForDedup(entry.content) === target
    ) {
      return { entry, created: false };
    }
  }

  if (existing.length >= MEMORY_MAX_COUNT) {
    throw new Error(`memory is full (${MEMORY_MAX_COUNT} entries) — delete some in Settings`);
  }
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: allocateMemoryId(trimmed, new Set(existing.map((e) => e.id))),
    content: trimmed,
    source,
    accountId: normalizedAccountId,
    contactId: normalizedContactId,
    usedCount: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeMemoryEntryFile(entry);
  emitServerEvent("memories");
  return { entry, created: true };
}

/**
 * Resolve a full memory id or an unambiguous id prefix (≥6 chars, as shown
 * bracketed in the system prompt) to its entry. Null when not found or when
 * a short prefix matches more than one entry.
 */
function resolveEntry(idOrPrefix: string, entries: MemoryEntry[]): MemoryEntry | null {
  const trimmed = idOrPrefix.trim();
  if (!trimmed) return null;
  const exact = entries.find((entry) => entry.id === trimmed);
  if (exact) return exact;
  if (trimmed.length < 6) return null;
  const matches = entries.filter((entry) => entry.id.startsWith(trimmed));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function updateMemory(
  idOrPrefix: string,
  content: string,
  /** undefined = keep the current account scope; null = clear it. */
  accountId?: string | null,
  /** undefined = keep the current contact scope; null = clear it. */
  contactId?: string | null,
): Promise<MemoryEntry | null> {
  const entries = await listMemories();
  const current = resolveEntry(idOrPrefix, entries);
  if (!current) return null;
  const trimmed = content.trim();
  if (!trimmed) throw new Error("memory content must not be empty");
  if (trimmed.length > MEMORY_MAX_LENGTH) {
    throw new Error(`memory content must be at most ${MEMORY_MAX_LENGTH} characters`);
  }

  // An empty string on either axis means "clear it", same as null; the route
  // layer's schema coercion can deliver "" where the client sent an explicit
  // null. undefined still means "keep the current value".
  const normalizedAccountId = accountId === undefined ? undefined : accountId || null;
  const normalizedContactId =
    contactId !== undefined ? (contactId ? normalizeContactId(contactId) : null) : undefined;
  let nextAccountId = normalizedAccountId !== undefined ? normalizedAccountId : current.accountId;
  let nextContactId = normalizedContactId !== undefined ? normalizedContactId : current.contactId;
  // Setting one scope axis moves the entry there: the other axis clears unless
  // the caller sent it too. Under the one-scope rule, "set this axis and keep
  // the other" could only ever be a conflict; a caller moving a memory's
  // scope shouldn't have to know (and explicitly clear) its previous one.
  if (normalizedAccountId != null && normalizedContactId === undefined) nextContactId = null;
  if (normalizedContactId != null && normalizedAccountId === undefined) nextAccountId = null;
  assertSingleScope(nextAccountId, nextContactId);

  // The filename follows the content: a content change renames the file so
  // the browsable folder never lies about what a file holds.
  const contentChanged = trimmed !== current.content;
  const taken = new Set(entries.filter((e) => e.id !== current.id).map((e) => e.id));
  const next: MemoryEntry = {
    ...current,
    id: contentChanged ? allocateMemoryId(trimmed, taken) : current.id,
    content: trimmed,
    accountId: nextAccountId,
    contactId: nextContactId,
    updatedAt: new Date().toISOString(),
  };
  await writeMemoryEntryFile(next);
  if (next.id !== current.id) await rm(entryPath(current.id)).catch(() => {});
  emitServerEvent("memories");
  return next;
}

export async function deleteMemory(idOrPrefix: string): Promise<boolean> {
  const entry = resolveEntry(idOrPrefix, await listMemories());
  if (!entry) return false;
  try {
    await rm(entryPath(entry.id));
  } catch {
    return false;
  }
  emitServerEvent("memories");
  return true;
}

/**
 * Bump the usage counter (and stamp lastUsedAt) for each memory the agent
 * reported relying on this turn via the memory_used tool. Accepts full ids or
 * the ≥6-char prefixes shown bracketed in the prompt; unresolved or duplicate
 * ids are skipped silently, so a miscited id never fails the turn. Returns
 * the entries actually recorded.
 */
export async function recordMemoryUse(idsOrPrefixes: string[]): Promise<MemoryEntry[]> {
  const entries = await listMemories();
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const recorded: MemoryEntry[] = [];
  for (const raw of idsOrPrefixes) {
    const entry = resolveEntry(raw, entries);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const next = { ...entry, usedCount: entry.usedCount + 1, lastUsedAt: now };
    await writeMemoryEntryFile(next);
    recorded.push(next);
  }
  if (recorded.length > 0) emitServerEvent("memories");
  return recorded;
}
