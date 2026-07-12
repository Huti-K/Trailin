import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatFileSize, type MemoryEntry } from "@trailin/shared";
import { and, desc, eq, gte, inArray, like } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createMemory, deleteMemory, listMemories, updateMemory } from "../db/memories.js";
import { getLibraryDir, SUPPORTED_FORMATS, saveNote } from "../library/ingest.js";
import { getDocument, listDocuments, readDocumentChunks, searchChunks } from "../library/store.js";
import { errorMessage } from "../util.js";
import { fetchAccountNameMap, resolveAccountParam } from "./accounts.js";
import { defineTool, textResult } from "./toolResult.js";

/**
 * The agent's local knowledge tools: long-term memory plus the document
 * library (the drop folder). Everything is served from SQLite — no network,
 * no extra processes.
 */

/** Chunks per library_read part; ≈ 15k characters. Search hits cite these parts. */
const PART_CHUNKS = 8;

/** Lowercased, trimmed — matches how contacts.address and memories.contactId are normalized. */
function normalizeContactAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** "Anna Becker <anna@firm.de>" when the contacts table has a display name, else the bare address. */
async function contactLabel(address: string): Promise<string> {
  const [row] = await db
    .select({ displayName: schema.contacts.displayName })
    .from(schema.contacts)
    .where(eq(schema.contacts.address, address));
  return row?.displayName ? `${row.displayName} <${address}>` : address;
}

const memorySave: AgentTool = defineTool({
  name: "memory_save",
  label: "Save to memory",
  description:
    `Save one short, standing fact to long-term memory — a single self-contained sentence ` +
    `(people, sign-offs, recurring context). Saved entries appear in your system prompt in ` +
    `every future conversation, so keep them terse. Do not save one-off task details, whole ` +
    `emails, or things already in memory. Anything longer-form or document-shaped — ` +
    `correspondent background, a thread summary, research findings — belongs in the library ` +
    `instead: use library_write. The user can review and edit memory on the Knowledge page. ` +
    `Facts that only apply to one connected account — a client of one company, a per-inbox rule ` +
    `or preference — should be scoped to it with the account parameter, so they only surface ` +
    `when acting as that account. Facts about one correspondent — their tone, preferences, how ` +
    `they like to be addressed — should be scoped with the contact parameter instead. Leave both ` +
    `unset for facts that apply everywhere; set at most one, never both.`,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The fact to remember, as one short self-contained sentence.",
      },
      account: {
        type: "string",
        description:
          `The email address of the connected account this fact is specific to (as shown in ` +
          `tool descriptions: "Acts as the connected account: …"); omit for facts that apply everywhere.`,
      },
      contact: {
        type: "string",
        description:
          `Scope this fact to a specific correspondent — their email address — instead of an ` +
          `account. Use for facts about one person (tone, preferences, how they like to be ` +
          `addressed); do not combine with account.`,
      },
    },
    required: ["content"],
  },
  execute: async (_id, params) => {
    const { content, account, contact } = params as {
      content: string;
      account?: string;
      contact?: string;
    };
    const accountRaw = account?.trim();
    const contactRaw = contact?.trim();
    if (accountRaw && contactRaw) {
      return textResult(
        "Scope a memory to an account or a contact, not both — pass only one, or leave both unset.",
      );
    }

    let accountId: string | null = null;
    let contactId: string | null = null;
    let scopeLabel = "general";
    if (accountRaw) {
      const resolved = await resolveAccountParam(accountRaw);
      if (resolved.error) return textResult(resolved.error);
      accountId = resolved.account?.id ?? null;
      scopeLabel = resolved.account?.name ?? "general";
    } else if (contactRaw) {
      contactId = normalizeContactAddress(contactRaw);
      scopeLabel = await contactLabel(contactId);
    }

    const { entry, created } = await createMemory(content, "agent", accountId, contactId);
    return textResult(
      created
        ? `Saved to long-term memory (${scopeLabel}): ${entry.content}`
        : `Already in memory (${scopeLabel}): ${entry.content}`,
    );
  },
});

const memoryUpdate: AgentTool = defineTool({
  name: "memory_update",
  label: "Update memory",
  description:
    `Update one long-term memory entry when a fact has changed or the user corrects it — ` +
    `instead of saving a second, contradicting entry. Use the id shown in brackets in the ` +
    `Long-term memory list in your system prompt. Pass account to move the entry into a ` +
    `connected account's scope (facts specific to one inbox or client), or contact to scope ` +
    `this fact to a specific correspondent — their email address — instead of an account; pass ` +
    `either as "general" to make the entry apply everywhere. Omit both to keep the entry's ` +
    `current scope; never pass both account and contact with a real value.`,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The memory id (the bracketed id from the Long-term memory list).",
      },
      content: {
        type: "string",
        description: "The corrected fact, as one short self-contained sentence.",
      },
      account: {
        type: "string",
        description:
          `The email address of the connected account to scope this entry to, or "general" to ` +
          `make it apply everywhere; omit to keep its current scope.`,
      },
      contact: {
        type: "string",
        description:
          `The email address of the correspondent to scope this entry to, or "general" to make ` +
          `it apply everywhere; omit to keep its current scope. Do not combine with account.`,
      },
    },
    required: ["id", "content"],
  },
  execute: async (_id, params) => {
    const { id, content, account, contact } = params as {
      id: string;
      content: string;
      account?: string;
      contact?: string;
    };
    const accountRaw = account?.trim();
    const contactRaw = contact?.trim();
    const accountIsGeneral = accountRaw?.toLowerCase() === "general";
    const contactIsGeneral = contactRaw?.toLowerCase() === "general";
    if (accountRaw && contactRaw && !accountIsGeneral && !contactIsGeneral) {
      return textResult(
        "Scope a memory to an account or a contact, not both — pass only one, or leave both unset.",
      );
    }

    let accountId: string | null | undefined;
    let contactId: string | null | undefined;
    if (accountIsGeneral || contactIsGeneral) {
      // "general" on either parameter means the same thing: clear both scope axes.
      accountId = null;
      contactId = null;
    } else if (accountRaw) {
      const resolved = await resolveAccountParam(accountRaw);
      if (resolved.error) return textResult(resolved.error);
      accountId = resolved.account?.id;
      contactId = null;
    } else if (contactRaw) {
      contactId = normalizeContactAddress(contactRaw);
      accountId = null;
    }

    const entry = await updateMemory(id, content, accountId, contactId);
    if (!entry) {
      return textResult(
        `No memory found for id ${id} — use the id from the Long-term memory list.`,
      );
    }
    return textResult(`Memory updated: ${entry.content}`);
  },
});

const memoryDelete: AgentTool = defineTool({
  name: "memory_delete",
  label: "Delete memory",
  description:
    `Delete one long-term memory entry. Use only when the user asks to forget something or a ` +
    `fact is clearly obsolete — not to make room for an update, use memory_update for that. ` +
    `Use the id shown in brackets in the Long-term memory list in your system prompt.`,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The memory id (the bracketed id from the Long-term memory list).",
      },
    },
    required: ["id"],
  },
  execute: async (_id, params) => {
    const { id } = params as { id: string };
    const deleted = await deleteMemory(id);
    if (!deleted) {
      return textResult(
        `No memory found for id ${id} — use the id from the Long-term memory list.`,
      );
    }
    return textResult(`Memory deleted.`);
  },
});

const libraryList: AgentTool = defineTool({
  name: "library_list",
  label: "List library documents",
  description:
    `List every document in the user's local library (files they dropped into the library ` +
    `folder or uploaded in Settings). Returns each document's title and id for library_read.`,
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const documents = await listDocuments();
    if (documents.length === 0) {
      return textResult(
        `The library is empty. The user can drop ${SUPPORTED_FORMATS} files into ` +
          `${getLibraryDir()} (or upload them on the Knowledge page).`,
      );
    }
    const lines = documents.map((d) => {
      const state =
        d.status === "error"
          ? ` — indexing failed: ${d.error ?? "unknown error"}`
          : `, ${Math.max(1, Math.ceil(d.chunkCount / PART_CHUNKS))} part(s)`;
      return `- ${d.title} (${d.ext}, ${formatFileSize(d.size)}${state}) — id: ${d.id}`;
    });
    return textResult(lines.join("\n"));
  },
});

const librarySearch: AgentTool = defineTool({
  name: "library_search",
  label: "Search library",
  description:
    `Keyword search across the user's local document library (PDFs, notes). Returns matching ` +
    `passages with their document id and part number — read the full context with ` +
    `library_read. Use distinctive keywords from the question; if nothing matches, retry ` +
    `with synonyms or fewer terms.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms (keywords, not a sentence)." },
      limit: { type: "number", description: "Max results, 1–20 (default 8)." },
    },
    required: ["query"],
  },
  execute: async (_id, params) => {
    const { query, limit } = params as { query: string; limit?: number };
    const capped = Math.max(1, Math.min(20, Math.round(limit ?? 8)));
    const hits = searchChunks(query, capped);
    if (hits.length === 0) {
      return textResult(`No matches for "${query}". Try other keywords, or library_list.`);
    }
    const lines = hits.map(
      (h) =>
        `[${h.title} — part ${Math.floor(h.seq / PART_CHUNKS) + 1}, id: ${h.documentId}]\n${h.snippet}`,
    );
    return textResult(lines.join("\n\n"));
  },
});

const libraryRead: AgentTool = defineTool({
  name: "library_read",
  label: "Read library document",
  description:
    `Read a document from the user's library by id (from library_search or library_list). ` +
    `Long documents come in parts of ~15k characters — pass "part" to continue reading.`,
  parameters: {
    type: "object",
    properties: {
      documentId: { type: "string", description: "The document id." },
      part: { type: "number", description: "1-based part to read (default 1)." },
    },
    required: ["documentId"],
  },
  execute: async (_id, params) => {
    const { documentId, part } = params as { documentId: string; part?: number };
    const doc = await getDocument(documentId);
    if (!doc) return textResult(`No document with id ${documentId} — check library_list.`);
    if (doc.status === "error") {
      return textResult(`"${doc.title}" could not be indexed: ${doc.error ?? "unknown error"}.`);
    }
    const chunks = readDocumentChunks(documentId);
    const totalParts = Math.max(1, Math.ceil(chunks.length / PART_CHUNKS));
    const wanted = Math.max(1, Math.min(totalParts, Math.round(part ?? 1)));
    const body = chunks.slice((wanted - 1) * PART_CHUNKS, wanted * PART_CHUNKS).join("");
    const header =
      `${doc.title} (${doc.path}) — part ${wanted}/${totalParts}` +
      (wanted < totalParts ? ` — call again with part: ${wanted + 1} for more` : "");
    return textResult(`${header}\n\n${body || "(empty document)"}`);
  },
});

const libraryWrite: AgentTool = defineTool({
  name: "library_write",
  label: "Write library note",
  description:
    `Save longer-form knowledge as a markdown note in the user's library — background on a ` +
    `correspondent, a thread summary, research findings, anything too long or document-shaped ` +
    `for memory. Writing the same title again overwrites the note, so use that to update it. ` +
    `Notes are indexed like any library document: find them later with library_search or read ` +
    `them with library_read. The user sees the note on the Knowledge page and can edit or ` +
    `delete it there. Not for one-sentence standing facts — use memory_save for those.`,
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A short note title — becomes the file name (reuse an existing note's title to overwrite it).",
      },
      content: {
        type: "string",
        description: "The note body, as markdown.",
      },
    },
    required: ["title", "content"],
  },
  execute: async (_id, params) => {
    const { title, content } = params as { title: string; content: string };
    try {
      const path = await saveNote(title, content);
      return textResult(
        `Saved note to the library at ${path} — it's now searchable with library_search.`,
      );
    } catch (error) {
      return textResult(errorMessage(error));
    }
  },
});

/** Collapses all whitespace (including newlines) to single spaces, for previews. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const HISTORY_DEFAULT_DAYS = 14;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const HISTORY_PREVIEW_CHARS = 200;

const automationHistory: AgentTool = defineTool({
  name: "automation_history",
  label: "Automation run history",
  description:
    `Past scheduled-automation runs (morning briefings, end-of-day learnings, etc.) — use ` +
    `when the user references "your briefing", "you flagged X", or asks what an automation ` +
    `found or did on some day. Lists recent runs newest first with a short preview of each ` +
    `result; call automation_run_read with a run's id for the full text.`,
  parameters: {
    type: "object",
    properties: {
      automationName: {
        type: "string",
        description:
          'Only runs of the automation whose name contains this (partial match), e.g. "Morning briefing".',
      },
      days: {
        type: "number",
        description: `How many days back to look (default ${HISTORY_DEFAULT_DAYS}).`,
      },
      limit: {
        type: "number",
        description: `Max runs to return, 1–${HISTORY_MAX_LIMIT} (default ${HISTORY_DEFAULT_LIMIT}).`,
      },
    },
  },
  execute: async (_id, params) => {
    const { automationName, days, limit } = params as {
      automationName?: string;
      days?: number;
      limit?: number;
    };
    const windowDays = Math.max(1, Math.round(days ?? HISTORY_DEFAULT_DAYS));
    const capped = Math.max(
      1,
      Math.min(HISTORY_MAX_LIMIT, Math.round(limit ?? HISTORY_DEFAULT_LIMIT)),
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const conditions = [gte(schema.automationRuns.startedAt, since)];
    const name = automationName?.trim();
    if (name) conditions.push(like(schema.automations.name, `%${name}%`));

    const rows = await db
      .select({
        id: schema.automationRuns.id,
        name: schema.automations.name,
        status: schema.automationRuns.status,
        result: schema.automationRuns.result,
        startedAt: schema.automationRuns.startedAt,
      })
      .from(schema.automationRuns)
      .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(and(...conditions))
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(capped);

    if (rows.length === 0) {
      return textResult(
        name
          ? `No automation runs matching "${name}" in the last ${windowDays} day(s).`
          : `No automation runs in the last ${windowDays} day(s).`,
      );
    }

    const lines = rows.map((r) => {
      const collapsed = collapseWhitespace(r.result);
      const preview = collapsed.slice(0, HISTORY_PREVIEW_CHARS);
      const suffix = collapsed.length > HISTORY_PREVIEW_CHARS ? "…" : "";
      return (
        `- [${r.id}] ${r.name ?? "(deleted automation)"} — ${r.status} — ${r.startedAt}` +
        (preview ? ` — ${preview}${suffix}` : "")
      );
    });
    return textResult(lines.join("\n"));
  },
});

const automationRunRead: AgentTool = defineTool({
  name: "automation_run_read",
  label: "Read automation run",
  description:
    `Read one past automation run in full — its complete result text plus the automation ` +
    `name, status, and timestamps. Use the run id shown in brackets by automation_history.`,
  parameters: {
    type: "object",
    properties: {
      runId: { type: "string", description: "The run id (from automation_history)." },
    },
    required: ["runId"],
  },
  execute: async (_id, params) => {
    const { runId } = params as { runId: string };
    const [row] = await db
      .select({
        name: schema.automations.name,
        status: schema.automationRuns.status,
        result: schema.automationRuns.result,
        startedAt: schema.automationRuns.startedAt,
        finishedAt: schema.automationRuns.finishedAt,
      })
      .from(schema.automationRuns)
      .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(eq(schema.automationRuns.id, runId));

    if (!row) {
      return textResult(
        `No automation run found for id ${runId} — use automation_history to look up run ids.`,
      );
    }

    const header =
      `${row.name ?? "(deleted automation)"} — ${row.status} — started ${row.startedAt}` +
      (row.finishedAt ? `, finished ${row.finishedAt}` : "");
    return textResult(`${header}\n\n${row.result || "(empty result)"}`);
  },
});

export function buildKnowledgeTools(): AgentTool[] {
  return [
    memorySave,
    memoryUpdate,
    memoryDelete,
    libraryList,
    librarySearch,
    libraryRead,
    libraryWrite,
    automationHistory,
    automationRunRead,
  ];
}

/**
 * Read-only subset of the knowledge tools — no memory writes, no
 * library_write — given to background delegate workers.
 */
export function buildKnowledgeReadTools(): AgentTool[] {
  return [libraryList, librarySearch, libraryRead, automationHistory, automationRunRead];
}

/** Library titles listed in the system prompt are capped so it can't grow unbounded. */
const LIBRARY_TOC_LIMIT = 100;

/**
 * The dynamic context sections shared by the main agent's and the background
 * workers' system prompts: saved memories plus the library table of contents.
 * Returns "" when there is nothing to show.
 */
export async function buildKnowledgeContext(): Promise<string> {
  let context = "";

  const memories = await listMemories();
  if (memories.length > 0) {
    const format = (list: MemoryEntry[]) =>
      list.map((m) => `- [${m.id.slice(0, 8)}] ${m.content}`).join("\n");

    const global = memories.filter((m) => m.accountId === null && m.contactId === null);
    const accountScoped = memories.filter((m) => m.accountId !== null);
    const contactScoped = memories.filter((m) => m.contactId !== null);

    const sections: string[] = [];
    if (global.length > 0) sections.push(format(global));

    if (accountScoped.length > 0) {
      const names = await fetchAccountNameMap();
      const byAccount = new Map<string, MemoryEntry[]>();
      for (const m of accountScoped) {
        const key = m.accountId as string;
        const list = byAccount.get(key);
        if (list) list.push(m);
        else byAccount.set(key, [m]);
      }
      for (const [accountId, entries] of byAccount) {
        const name = names.get(accountId) ?? accountId;
        sections.push(
          `Memory for ${name} (applies only when reading or writing as this account):\n${format(entries)}`,
        );
      }
    }

    if (contactScoped.length > 0) {
      const byContact = new Map<string, MemoryEntry[]>();
      for (const m of contactScoped) {
        const key = m.contactId as string;
        const list = byContact.get(key);
        if (list) list.push(m);
        else byContact.set(key, [m]);
      }
      const addresses = [...byContact.keys()];
      const contactRows = await db
        .select({ address: schema.contacts.address, displayName: schema.contacts.displayName })
        .from(schema.contacts)
        .where(inArray(schema.contacts.address, addresses));
      const namesByAddress = new Map(contactRows.map((r) => [r.address, r.displayName]));
      for (const [address, entries] of byContact) {
        const name = namesByAddress.get(address);
        const label = name ? `${name} <${address}>` : address;
        sections.push(
          `Memory about ${label} (applies only when corresponding with them):\n${format(entries)}`,
        );
      }
    }

    context += `\n\nLong-term memory (saved earlier; the user manages these on the Knowledge page):\n${sections.join("\n\n")}`;
  }

  const indexed = (await listDocuments()).filter((d) => d.status === "indexed" && d.chunkCount > 0);
  if (indexed.length > 0) {
    const shown = indexed.slice(0, LIBRARY_TOC_LIMIT);
    const lines = shown.map((d) => `- ${d.title} (${d.ext})`);
    if (indexed.length > shown.length) {
      lines.push(`… and ${indexed.length - shown.length} more — use library_list.`);
    }
    context += `\n\nDocument library (search with library_search, read with library_read):\n${lines.join("\n")}`;
  }
  return context;
}
