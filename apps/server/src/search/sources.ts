import type { SearchResult } from "@trailin/shared";
import { and, desc, eq, ne, or } from "drizzle-orm";
import { db, lazyStatement, schema } from "../db/index.js";
import { likePattern } from "../db/like.js";
import { listMemories } from "../db/memories.js";
import { buildFtsMatch } from "../db/sql.js";
import { listDraftsCached } from "../email/draftsCache.js";
import { getDraftProvider } from "../email/providers.js";
import { listDocuments, searchChunks } from "../library/store.js";
import { moduleLogger } from "../logger.js";
import { listAccounts } from "../pipedream/connect.js";
import { buildSnippet, plainText } from "./snippets.js";

const log = moduleLogger("search");

/** Results per source type; the palette shows a handful under each heading, not a wall of hits. */
const PER_TYPE_LIMIT = 6;

interface MessageHitRow {
  id: string;
  title: string;
  createdAt: string;
  content: string;
}

// messages_fts is external-content (see db/index.ts) — it holds no text of its
// own, so every hit is joined back to `messages` by rowid to read `content`,
// and to `conversations` for the title/type/id the palette actually shows.
// The MATCH operand must be the FTS5 table's own name, not an alias, or
// SQLite treats it as a plain (nonexistent) column reference.
const messageHitsStmt = lazyStatement(`
  SELECT c.id AS id, c.title AS title, c.created_at AS createdAt, m.content AS content
  FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid
  JOIN conversations c ON c.id = m.conversation_id
  WHERE messages_fts MATCH ? AND c.type != 'automation'
  ORDER BY m.created_at DESC
  LIMIT ?
`);

/**
 * Chat conversations (type != "automation"): matches on title or any message
 * content, one hit per conversation. Message matches are checked first (they
 * carry a more useful snippet); title-only matches fill the remaining slots.
 */
export async function searchChats(query: string, pattern: string): Promise<SearchResult[]> {
  const match = buildFtsMatch(query, "AND");
  const messageHits = match
    ? (messageHitsStmt().all(match, PER_TYPE_LIMIT * 4) as MessageHitRow[])
    : [];

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of messageHits) {
    if (results.length >= PER_TYPE_LIMIT) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    results.push({
      type: "chat",
      id: row.id,
      title: row.title,
      snippet: buildSnippet(row.content, query),
      date: row.createdAt,
    });
  }

  if (results.length < PER_TYPE_LIMIT) {
    const titleHits = await db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        createdAt: schema.conversations.createdAt,
      })
      .from(schema.conversations)
      .where(
        and(
          ne(schema.conversations.type, "automation"),
          likePattern(schema.conversations.title, pattern),
        ),
      )
      .orderBy(desc(schema.conversations.createdAt))
      .limit(PER_TYPE_LIMIT * 2);
    for (const row of titleHits) {
      if (results.length >= PER_TYPE_LIMIT) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      results.push({
        type: "chat",
        id: row.id,
        title: row.title,
        snippet: buildSnippet(row.title, query),
        date: row.createdAt,
      });
    }
  }
  return results;
}

/**
 * Automation runs (the Digest feed): matches on the run's result text or its
 * automation's name. A run's mirrored conversation shares the run's id, so
 * the web app opens these hits exactly like a chat.
 */
export async function searchRuns(query: string, pattern: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: schema.automationRuns.id,
      result: schema.automationRuns.result,
      startedAt: schema.automationRuns.startedAt,
      automationName: schema.automations.name,
    })
    .from(schema.automationRuns)
    .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
    .where(
      or(
        likePattern(schema.automationRuns.result, pattern),
        likePattern(schema.automations.name, pattern),
      ),
    )
    .orderBy(desc(schema.automationRuns.startedAt))
    .limit(PER_TYPE_LIMIT);

  return rows.map((row) => {
    const name = row.automationName ?? "Automation";
    const dateLabel = row.startedAt ? row.startedAt.slice(0, 10) : "";
    const q = query.toLowerCase();
    const snippetSource = row.result?.toLowerCase().includes(q) ? row.result : name;
    return {
      type: "run" as const,
      id: row.id,
      title: dateLabel ? `${name} · ${dateLabel}` : name,
      snippet: buildSnippet(snippetSource, query),
      date: row.startedAt,
    };
  });
}

/**
 * Unsent drafts across every connected account that has a DraftProvider
 * (Gmail, Outlook, ...) — accounts for apps with no draft driver (Notion,
 * Slack, zoho_mail, ...) are skipped rather than attempted. Fetches each
 * such account's drafts in parallel and matches on subject/to only —
 * fetching every draft's full body just to search would be too slow.
 */
export async function searchDrafts(query: string): Promise<SearchResult[]> {
  const q = query.toLowerCase();
  const contains = (value: string | undefined) => !!value && value.toLowerCase().includes(q);
  const results: SearchResult[] = [];

  const accounts = (await listAccounts()).filter((a) => getDraftProvider(a.app) !== null);
  // Cached (and, on a stale hit, stale-while-revalidate) rather than a live
  // fetch — the palette searches drafts on every keystroke, and a live
  // provider round-trip per account per keystroke would make it feel
  // sluggish for no benefit (drafts don't change that fast).
  const settled = await Promise.allSettled(accounts.map((account) => listDraftsCached(account)));
  for (let i = 0; i < accounts.length; i++) {
    if (results.length >= PER_TYPE_LIMIT) break;
    const outcome = settled[i];
    const account = accounts[i];
    if (!outcome || !account || outcome.status !== "fulfilled") continue;
    for (const draft of outcome.value) {
      if (results.length >= PER_TYPE_LIMIT) break;
      const subjectHit = contains(draft.subject);
      const toHit = contains(draft.to);
      if (!subjectHit && !toHit) continue;
      results.push({
        type: "draft",
        id: draft.id,
        title: draft.subject || "(no subject)",
        snippet: buildSnippet(subjectHit ? draft.subject : draft.to, query),
        date: draft.date,
        accountId: account.id,
      });
    }
  }
  return results;
}

/** Library documents: content matches via the library's FTS5 chunk search, then title-only matches. */
export async function searchDocuments(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const hit of searchChunks(query, PER_TYPE_LIMIT * 3)) {
    if (results.length >= PER_TYPE_LIMIT) break;
    if (seen.has(hit.documentId)) continue;
    seen.add(hit.documentId);
    results.push({
      type: "document",
      id: hit.documentId,
      title: hit.title,
      snippet: plainText(hit.snippet),
    });
  }

  if (results.length < PER_TYPE_LIMIT) {
    const q = query.toLowerCase();
    for (const doc of await listDocuments()) {
      if (results.length >= PER_TYPE_LIMIT) break;
      if (seen.has(doc.id) || !doc.title.toLowerCase().includes(q)) continue;
      seen.add(doc.id);
      results.push({
        type: "document",
        id: doc.id,
        title: doc.title,
        snippet: buildSnippet(doc.title, query),
      });
    }
  }
  return results;
}

/** Long-term memory entries matching on content; most recently updated first. */
export async function searchMemories(query: string): Promise<SearchResult[]> {
  const q = query.toLowerCase();
  const hits = (await listMemories())
    .filter((entry) => entry.content.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, PER_TYPE_LIMIT);
  return hits.map((entry) => ({
    type: "memory",
    id: entry.id,
    title: entry.content.length > 60 ? `${entry.content.slice(0, 60)}…` : entry.content,
    snippet: buildSnippet(entry.content, query),
    date: entry.updatedAt,
  }));
}

/**
 * Runs one source, logging and falling back to an empty list on failure
 * instead of throwing — so a corrupt index or a downed provider blanks only
 * its own heading in the search palette rather than the whole `Promise.all`.
 */
export function safeSource(source: string, run: Promise<SearchResult[]>): Promise<SearchResult[]> {
  return run.catch((err: unknown) => {
    log.warn({ err, source }, "search source failed");
    return [];
  });
}
