import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { formatFileSize, MEMORY_MAX_COUNT, type MemoryEntry } from "@trailin/shared";
import { groupBy } from "../core/utils/util.js";
import { getLibraryDir, SUPPORTED_FORMATS } from "../storage/library/ingest.js";
import {
  getDocument,
  listDocuments,
  readDocumentChunks,
  searchChunks,
} from "../storage/library/store.js";
import {
  createMemory,
  deleteMemory,
  listMemories,
  recordMemoryUse,
  updateMemory,
} from "../storage/memories/store.js";
import { fetchAccountNameMap, resolveAccountParam } from "./accounts.js";
import { clampLimit, textResult, tool } from "./toolkit.js";

/** Chunks per library_read part, ≈ 15k characters. */
const PART_CHUNKS = 8;

interface MemoryScope {
  accountId: string | null;
  contactId: string | null;
  label: string;
}

/** contact:<address> is lowercased to match how memories.contactId is normalized. */
async function resolveMemoryScope(raw: string): Promise<MemoryScope | { error: string }> {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "general") {
    return { accountId: null, contactId: null, label: "general" };
  }
  const separator = trimmed.indexOf(":");
  const prefix = separator === -1 ? "" : trimmed.slice(0, separator).trim().toLowerCase();
  const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (prefix === "account" && value) {
    const { account, error } = await resolveAccountParam(value, "required");
    if (!account) return { error: error ?? `No connected account matches "${value}".` };
    return { accountId: account.id, contactId: null, label: account.name };
  }
  if (prefix === "contact" && value) {
    const contactId = value.toLowerCase();
    return { accountId: null, contactId, label: contactId };
  }
  return {
    error: `Unrecognized scope "${trimmed}" — use "general", "account:<address>" or "contact:<address>".`,
  };
}

const SCOPE_FORMS =
  `"general" (applies everywhere), "account:<address>" (one connected account) or ` +
  `"contact:<address>" (one correspondent)`;

const memorySave: AgentTool = tool({
  name: "memory_save",
  label: "Save to memory",
  description:
    `Save one short, standing fact to long-term memory — a single self-contained sentence ` +
    `(people, sign-offs, recurring context). Saved entries appear in your system prompt in ` +
    `every future conversation, so keep them terse. Do not save one-off task details, whole ` +
    `emails, or things already in memory. Anything longer-form or document-shaped — ` +
    `correspondent background, a thread summary, research findings — belongs in your knowledge ` +
    `folder instead: write it as a markdown note under knowledge/notes/ with file_write, and it ` +
    `gets indexed for library_search. The user can review and edit memory on the Knowledge ` +
    `page. When you file a longer note that should be remembered proactively, also save a ` +
    `one-sentence memory naming it.`,
  params: {
    content: Type.String({
      description: "The fact to remember, as one short self-contained sentence.",
    }),
    scope: Type.Optional(
      Type.String({
        description:
          `Where the fact applies; omit for facts that apply everywhere. "account:<address>" ` +
          `scopes it to that connected account (a client of one company, a per-inbox rule or ` +
          `preference) so it only surfaces when acting as that account; "contact:<address>" ` +
          `scopes it to one correspondent (their tone, preferences, how they like to be ` +
          `addressed) so it only surfaces when corresponding with them.`,
      }),
    ),
  },
  execute: async ({ content, scope }) => {
    let target: MemoryScope = { accountId: null, contactId: null, label: "general" };
    if (scope?.trim()) {
      const resolved = await resolveMemoryScope(scope);
      if ("error" in resolved) return textResult(resolved.error);
      target = resolved;
    }
    const { entry, created } = await createMemory(
      content,
      "agent",
      target.accountId,
      target.contactId,
    );
    return textResult(
      created
        ? `Saved to long-term memory (${target.label}): ${entry.content}`
        : `Already in memory (${target.label}): ${entry.content}`,
    );
  },
});

const memoryUpdate: AgentTool = tool({
  name: "memory_update",
  label: "Update memory",
  description:
    `Update one long-term memory entry when a fact has changed or the user corrects it — ` +
    `instead of saving a second, contradicting entry. Use the id shown in brackets in the ` +
    `Long-term memory list in your system prompt. Pass scope to move the entry — ` +
    `${SCOPE_FORMS} — or omit it to keep the entry's current scope.`,
  params: {
    id: Type.String({
      description: "The memory id (the bracketed id from the Long-term memory list).",
    }),
    content: Type.String({
      description: "The corrected fact, as one short self-contained sentence.",
    }),
    scope: Type.Optional(
      Type.String({
        description: `Move the entry: ${SCOPE_FORMS}. Omit to keep the current scope.`,
      }),
    ),
  },
  execute: async ({ id, content, scope }) => {
    // undefined = keep the entry's current scope (updateMemory's contract).
    let accountId: string | null | undefined;
    let contactId: string | null | undefined;
    if (scope?.trim()) {
      const resolved = await resolveMemoryScope(scope);
      if ("error" in resolved) return textResult(resolved.error);
      accountId = resolved.accountId;
      contactId = resolved.contactId;
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

const memoryDelete: AgentTool = tool({
  name: "memory_delete",
  label: "Delete memory",
  description:
    `Delete one long-term memory entry. Use only when the user asks to forget something or a ` +
    `fact is clearly obsolete — not to make room for an update, use memory_update for that. ` +
    `Use the id shown in brackets in the Long-term memory list in your system prompt.`,
  params: {
    id: Type.String({
      description: "The memory id (the bracketed id from the Long-term memory list).",
    }),
  },
  execute: async ({ id }) => {
    const deleted = await deleteMemory(id);
    if (!deleted) {
      return textResult(
        `No memory found for id ${id} — use the id from the Long-term memory list.`,
      );
    }
    return textResult(`Memory deleted.`);
  },
});

const memoryUsed: AgentTool = tool({
  name: "memory_used",
  label: "Note memory used",
  description:
    `Record which long-term memories you actually relied on this turn — pass the bracketed ids ` +
    `(from the Long-term memory list in your system prompt) of every entry whose content shaped ` +
    `your reply, draft, or decision. Call it once, at the end of the turn, and only for memories ` +
    `you genuinely used — not every entry shown, and skip it entirely when no saved memory was ` +
    `relevant. It has no user-visible effect; it only tracks which memories earn their place so ` +
    `unused ones can be pruned.`,
  params: {
    ids: Type.Array(Type.String(), {
      description: "Bracketed ids of the memories you relied on this turn.",
    }),
  },
  execute: async ({ ids }) => {
    const recorded = await recordMemoryUse(ids);
    return textResult(
      recorded.length > 0
        ? `Noted ${recorded.length} memor${recorded.length === 1 ? "y" : "ies"} as used.`
        : "No matching memories to note.",
    );
  },
});

const libraryList: AgentTool = tool({
  name: "library_list",
  label: "List library documents",
  description:
    `List every document in the user's local library (files they dropped into the library ` +
    `folder or uploaded in Settings). Returns each document's title and id for library_read.`,
  params: {},
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

const librarySearch: AgentTool = tool({
  name: "library_search",
  label: "Search library",
  description:
    `Keyword search across the user's local document library (PDFs, notes). Returns matching ` +
    `passages with their document id and part number — read the full context with ` +
    `library_read. Use distinctive keywords from the question; if nothing matches, retry ` +
    `with synonyms or fewer terms.`,
  params: {
    query: Type.String({ description: "Search terms (keywords, not a sentence)." }),
    limit: Type.Optional(Type.Number({ description: "Max results, 1–20 (default 8)." })),
  },
  execute: async ({ query, limit: limitRaw }) => {
    const limit = clampLimit(limitRaw, 8, 20);
    const hits = searchChunks(query, limit);
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

const libraryRead: AgentTool = tool({
  name: "library_read",
  label: "Read library document",
  description:
    `Read a document from the user's library by id (from library_search or library_list). ` +
    `Long documents come in parts of ~15k characters — pass "part" to continue reading.`,
  params: {
    documentId: Type.String({ description: "The document id." }),
    part: Type.Optional(Type.Number({ description: "1-based part to read (default 1)." })),
  },
  execute: async ({ documentId, part }) => {
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

export function buildKnowledgeTools(): AgentTool[] {
  return [
    memorySave,
    memoryUpdate,
    memoryDelete,
    memoryUsed,
    libraryList,
    librarySearch,
    libraryRead,
  ];
}

/**
 * Read-only subset for background workers and unattended runs. memory_used is
 * included though it mutates: it only bumps a usage counter, so it can't
 * inject attacker-controlled content into a later prompt the way memory_save
 * could.
 */
export function buildKnowledgeReadTools(): AgentTool[] {
  return [memoryUsed, libraryList, librarySearch, libraryRead];
}

/** Caps library titles in the system prompt so it can't grow unbounded. */
const LIBRARY_TOC_LIMIT = 100;

export async function buildKnowledgeContext(): Promise<string> {
  let context = "";

  // The cap bounds the prompt even when the user hand-drops more files into
  // memory/ than createMemory would ever allow.
  const memories = (await listMemories()).slice(0, MEMORY_MAX_COUNT);
  if (memories.length > 0) {
    const format = (list: MemoryEntry[]) => list.map((m) => `- [${m.id}] ${m.content}`).join("\n");

    const global = memories.filter((m) => m.accountId === null && m.contactId === null);
    const accountScoped = memories.filter((m) => m.accountId !== null);
    const contactScoped = memories.filter((m) => m.contactId !== null);

    const sections: string[] = [];
    if (global.length > 0) sections.push(format(global));

    if (accountScoped.length > 0) {
      const names = await fetchAccountNameMap();
      const byAccount = groupBy(accountScoped, (m) => m.accountId as string);
      for (const [accountId, entries] of byAccount) {
        const name = names.get(accountId) ?? accountId;
        sections.push(
          `Memory for ${name} (applies only when reading or writing as this account):\n${format(entries)}`,
        );
      }
    }

    if (contactScoped.length > 0) {
      const byContact = groupBy(contactScoped, (m) => m.contactId as string);
      for (const [address, entries] of byContact) {
        sections.push(
          `Memory about ${address} (applies only when corresponding with them):\n${format(entries)}`,
        );
      }
    }

    context += `\n\nLong-term memory (saved earlier; the user manages these on the Knowledge page):\n${sections.join("\n\n")}\n\nWhen one of these memories shapes your reply, draft, or decision this turn, call memory_used at the end with the bracketed id(s) of the ones you actually relied on — only those, and skip the call when none were relevant.`;
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
