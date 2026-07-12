import { randomUUID } from "node:crypto";
import { MEMORY_MAX_LENGTH, type MemoryEntry } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { emitServerEvent } from "../events.js";
import { db, schema } from "./index.js";

/**
 * Long-term memory: small standing facts ("the user's landlord is …",
 * "always sign off with 'Beste Grüße'"). All entries are injected into the
 * agent's system prompt in full, so the length cap keeps each one to about a
 * sentence — anything longer-form (background, summaries, research) belongs
 * in the document library as a note instead (see library_write).
 */

// The cap is defined in @trailin/shared (the UI enforces it too); re-exported for server callers.
export { MEMORY_MAX_LENGTH };
export const MEMORY_MAX_COUNT = 200;

export async function listMemories(): Promise<MemoryEntry[]> {
  const rows = await db.select().from(schema.memories).orderBy(schema.memories.createdAt);
  return rows as MemoryEntry[];
}

/** Lowercase, whitespace-collapsed, no trailing period — for duplicate detection only. */
function normalizeForDedup(content: string): string {
  const collapsed = content.toLowerCase().replace(/\s+/g, " ").trim();
  return collapsed.replace(/\.$/, "");
}

export interface CreateMemoryResult {
  entry: MemoryEntry;
  /** False when an existing entry already matched and was returned instead. */
  created: boolean;
}

/** Lowercased, trimmed — matches how contacts.address is normalized. */
function normalizeContactId(contactId: string): string {
  return contactId.trim().toLowerCase();
}

/** A memory is global (both null), account-scoped, OR contact-scoped — never both. */
function assertSingleScope(accountId: string | null, contactId: string | null): void {
  if (accountId !== null && contactId !== null) {
    throw new Error("memory cannot be scoped to both an account and a contact");
  }
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
  // An empty string on either axis means "no scope" — the route layer's
  // schema coercion can deliver "" where the client sent an explicit null.
  const normalizedAccountId = accountId || null;
  const normalizedContactId = contactId ? normalizeContactId(contactId) : null;
  assertSingleScope(normalizedAccountId, normalizedContactId);

  // Dedup within the same (accountId, contactId) scope only — the same fact
  // may legitimately exist for two different accounts, two different
  // contacts, or once globally and once scoped.
  const rows = await db.select().from(schema.memories);
  const target = normalizeForDedup(trimmed);
  for (const row of rows) {
    if (
      (row.accountId ?? null) === normalizedAccountId &&
      (row.contactId ?? null) === normalizedContactId &&
      normalizeForDedup(row.content) === target
    ) {
      return { entry: row as MemoryEntry, created: false };
    }
  }

  if (rows.length >= MEMORY_MAX_COUNT) {
    throw new Error(`memory is full (${MEMORY_MAX_COUNT} entries) — delete some in Settings`);
  }
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: randomUUID(),
    content: trimmed,
    source,
    accountId: normalizedAccountId,
    contactId: normalizedContactId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.memories).values(entry);
  emitServerEvent("memories");
  return { entry, created: true };
}

/**
 * Resolve a full memory id or an unambiguous id prefix (≥6 chars, as shown
 * bracketed in the system prompt) to a full id. Null when not found or when
 * a short prefix matches more than one entry.
 */
export async function resolveMemoryId(idOrPrefix: string): Promise<string | null> {
  const trimmed = idOrPrefix.trim();
  if (!trimmed) return null;
  const rows = await db.select({ id: schema.memories.id }).from(schema.memories);
  if (rows.some((row) => row.id === trimmed)) return trimmed;
  if (trimmed.length < 6) return null;
  const matches = rows.filter((row) => row.id.startsWith(trimmed));
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

export async function updateMemory(
  idOrPrefix: string,
  content: string,
  /** undefined = keep the current account scope; null = clear it. */
  accountId?: string | null,
  /** undefined = keep the current contact scope; null = clear it. */
  contactId?: string | null,
): Promise<MemoryEntry | null> {
  const id = await resolveMemoryId(idOrPrefix);
  if (!id) return null;
  const trimmed = content.trim();
  if (!trimmed) throw new Error("memory content must not be empty");
  if (trimmed.length > MEMORY_MAX_LENGTH) {
    throw new Error(`memory content must be at most ${MEMORY_MAX_LENGTH} characters`);
  }
  const [current] = await db.select().from(schema.memories).where(eq(schema.memories.id, id));
  if (!current) return null;

  // An empty string on either axis means "clear it", same as null — the route
  // layer's schema coercion can deliver "" where the client sent an explicit
  // null. undefined still means "keep the current value".
  const normalizedAccountId = accountId === undefined ? undefined : accountId || null;
  const normalizedContactId =
    contactId !== undefined ? (contactId ? normalizeContactId(contactId) : null) : undefined;
  let nextAccountId =
    normalizedAccountId !== undefined ? normalizedAccountId : (current.accountId ?? null);
  let nextContactId =
    normalizedContactId !== undefined ? normalizedContactId : (current.contactId ?? null);
  // Setting one scope axis moves the entry there: the other axis clears unless
  // the caller sent it too. Under the one-scope rule, "set this axis and keep
  // the other" could only ever be a conflict — a caller moving a memory's
  // scope shouldn't have to know (and explicitly clear) its previous one.
  if (normalizedAccountId != null && normalizedContactId === undefined) nextContactId = null;
  if (normalizedContactId != null && normalizedAccountId === undefined) nextAccountId = null;
  assertSingleScope(nextAccountId, nextContactId);

  await db
    .update(schema.memories)
    .set({
      content: trimmed,
      updatedAt: new Date().toISOString(),
      accountId: nextAccountId,
      contactId: nextContactId,
    })
    .where(eq(schema.memories.id, id));
  emitServerEvent("memories");
  const [row] = await db.select().from(schema.memories).where(eq(schema.memories.id, id));
  if (!row) return null;
  return row as MemoryEntry;
}

export async function deleteMemory(idOrPrefix: string): Promise<boolean> {
  const id = await resolveMemoryId(idOrPrefix);
  if (!id) return false;
  await db.delete(schema.memories).where(eq(schema.memories.id, id));
  emitServerEvent("memories");
  return true;
}
