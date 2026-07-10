import type { FastifyInstance } from "fastify";
import { and, desc, eq, ne, or } from "drizzle-orm";
import type { SearchResult } from "@trailin/shared";
import { db, schema, sqlite } from "../db/index.js";
import { escapeLikeInput, likePattern } from "../util.js";
import { getDemoDraftStore } from "../db/settings.js";
import { env } from "../env.js";
import { listMemories } from "../db/memories.js";
import { listDocuments, searchChunks } from "../library/store.js";
import "../email/registerProviders.js";
import { listDraftsCached } from "../email/draftsService.js";
import { getDraftProvider } from "../email/providers.js";
import { listAccounts } from "../pipedream/connect.js";
import { moduleLogger } from "../logger.js";

const log = moduleLogger("search");

/**
 * Global search across chats, automation runs (digests), drafts, library
 * documents, and memories — powers the web app's command palette (Cmd+K).
 * Everything is read-only and best-effort: a failure in one source (e.g. a
 * Pipedream outage while fetching live drafts) never breaks the others.
 */

/** Results per source type; the palette shows a handful under each heading, not a wall of hits. */
const PER_TYPE_LIMIT = 6;

/**
 * Characters of context kept on each side of the first match (~320 total with the
 * match itself). The palette's list truncates this to one line; its preview pane
 * shows the whole thing, which is what the extra context is for.
 */
const SNIPPET_RADIUS = 160;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Chats, briefings and library documents all store markdown, but a palette
 * snippet is rendered as plain text — without this, hits read as literal
 * `## Zusammenfassung **selin@…**` noise. Runs before whitespace is collapsed,
 * because the line-anchored rules (headings, quotes, bullets) need the newlines.
 */
function stripMarkdown(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "")
      .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, " ")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
      // Emphasis only when the asterisks hug the text; `a * b` and `2 * 3` survive.
      .replace(/\*(\S(?:[^*]*\S)?)\*/g, "$1")
  );
}

/** Markdown stripped, whitespace collapsed — how every snippet reaches the palette. */
function plainText(text: string): string {
  return collapseWhitespace(stripMarkdown(text));
}

/** ~320 chars of context around the first case-insensitive match, or the start of the text. */
function buildSnippet(text: string, query: string): string {
  const collapsed = plainText(text);
  if (!collapsed) return "";
  const idx = collapsed.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return collapsed.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: every term double-quoted,
 * so FTS5 query syntax in the user's own input (`-`, `"`, `*`, ...) can't
 * break or redirect the query. Same quoting approach as library/store.ts's
 * buildMatch. Null when the query has no word/number characters to search on.
 */
export function buildMessagesMatch(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" ");
}

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
const messageHitsStmt = sqlite.prepare(`
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
async function searchChats(query: string, pattern: string): Promise<SearchResult[]> {
  const match = buildMessagesMatch(query);
  const messageHits = match
    ? (messageHitsStmt.all(match, PER_TYPE_LIMIT * 4) as MessageHitRow[])
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
      .where(and(ne(schema.conversations.type, "automation"), likePattern(schema.conversations.title, pattern)))
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
async function searchRuns(query: string, pattern: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: schema.automationRuns.id,
      result: schema.automationRuns.result,
      startedAt: schema.automationRuns.startedAt,
      automationName: schema.automations.name,
    })
    .from(schema.automationRuns)
    .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
    .where(or(likePattern(schema.automationRuns.result, pattern), likePattern(schema.automations.name, pattern)))
    .orderBy(desc(schema.automationRuns.startedAt))
    .limit(PER_TYPE_LIMIT);

  return rows.map((row) => {
    const name = row.automationName ?? "Automation";
    const dateLabel = row.startedAt ? row.startedAt.slice(0, 10) : "";
    const q = query.toLowerCase();
    const snippetSource =
      row.result && row.result.toLowerCase().includes(q) ? row.result : name;
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
 * Slack, zoho_mail, ...) are skipped rather than attempted. Demo mode
 * searches the seeded fake store (subject, to and body are all cheaply
 * available there); live mode fetches each such account's drafts in parallel
 * and matches on subject/to only — fetching every draft's full body just to
 * search would be too slow.
 */
async function searchDrafts(query: string): Promise<SearchResult[]> {
  const q = query.toLowerCase();
  const contains = (value: string | undefined) => !!value && value.toLowerCase().includes(q);
  const results: SearchResult[] = [];

  if (env.demoMode) {
    const store = await getDemoDraftStore();
    const all = Object.entries(store)
      .flatMap(([accountId, drafts]) => drafts.map((draft) => ({ accountId, draft })))
      .sort((a, b) => b.draft.date.localeCompare(a.draft.date));
    for (const { accountId, draft } of all) {
      if (results.length >= PER_TYPE_LIMIT) break;
      const subjectHit = contains(draft.subject);
      const toHit = contains(draft.to);
      const bodyHit = contains(draft.body);
      if (!subjectHit && !toHit && !bodyHit) continue;
      const snippetSource = subjectHit ? draft.subject : toHit ? draft.to : draft.body;
      results.push({
        type: "draft",
        id: draft.id,
        title: draft.subject || "(no subject)",
        snippet: buildSnippet(snippetSource, query),
        date: draft.date,
        accountId,
      });
    }
    return results;
  }

  const accounts = (await listAccounts()).filter((a) => getDraftProvider(a.app) !== null);
  // Cached (and, on a stale hit, stale-while-revalidate) rather than a live
  // fetch — the palette searches drafts on every keystroke, and a live
  // Gmail/Outlook round-trip per account per keystroke would make it feel
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

/** Library documents: content matches via the existing FTS5 chunk search, then title-only matches. */
async function searchDocuments(query: string): Promise<SearchResult[]> {
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
async function searchMemories(query: string): Promise<SearchResult[]> {
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
 * its own heading in the palette rather than the whole `Promise.all`.
 */
function safeSource(source: string, run: Promise<SearchResult[]>): Promise<SearchResult[]> {
  return run.catch((err: unknown) => {
    log.warn({ err, source }, "search source failed");
    return [];
  });
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const query = (req.query.q ?? "").trim();
    if (!query) return { results: [] };
    const pattern = `%${escapeLikeInput(query)}%`;

    const [runs, chats, drafts, documents, memories] = await Promise.all([
      safeSource("runs", searchRuns(query, pattern)),
      safeSource("chats", searchChats(query, pattern)),
      safeSource("drafts", searchDrafts(query)),
      safeSource("documents", searchDocuments(query)),
      safeSource("memories", searchMemories(query)),
    ]);

    // Grouped by type in a fixed order: run, chat, draft, document, memory.
    const results: SearchResult[] = [...runs, ...chats, ...drafts, ...documents, ...memories];
    return { results };
  });
}
