import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentCard, ConnectedAccount, EmailHit } from "@trailin/shared";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { listDraftsCached } from "../email/draftsService.js";
import { normalizeAddressSet } from "../email/learn/addressSubject.js";
import { getDraftProvider } from "../email/providers.js";
import {
  getThreadDetail,
  listSentMessages,
  listThreadOverviews,
  searchMail,
  type ThreadFilter,
  type ThreadMessage,
} from "../email/sync/mailQuery.js";
import { syncAccount } from "../email/sync/syncEngine.js";
import { mapWithConcurrency } from "../jobs.js";
import { errorMessage } from "../util.js";
import { accountNameMap, resolveAccountParam } from "./accounts.js";
import { toCardAccount } from "./cards.js";
import { defineTool, textResult } from "./toolResult.js";

/**
 * The agent's email READ tools, served entirely from the local mailbox
 * mirror (email/sync/) — no provider round-trips, so they're fast, work
 * offline, and cover every synced account in one call. All ids these tools
 * print are provider-native: threadId feeds create-draft replies and
 * read_thread, messageId feeds save-attachment. Writing (drafts, send,
 * labels) stays on the per-account provider tools.
 *
 * The mirror trails live mail by up to the sync interval (~3 minutes) and
 * reaches back SYNC_BACKFILL_DAYS (default 30); `refresh: true` pulls the
 * provider change feed first when the user asks about "right now".
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Cap per-message body text handed to the model; full mail can be enormous. */
const MAX_BODY_CHARS = 6_000;

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function truncateBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : body;
}

/** Pull the provider change feed before reading, for "right now" questions. */
async function refreshMirror(account: ConnectedAccount | undefined, all: ConnectedAccount[]) {
  const targets = account ? [account] : all;
  await mapWithConcurrency(targets, 4, (a) => syncAccount(a).catch(() => {}));
}

/** Contact-scoped memories quoted per participant in a read_thread block; keeps it compact. */
const MAX_CONTACT_MEMORIES = 5;

/**
 * Compact per-participant context appended after a full thread read, so
 * known-contact facts (relationship, tone, standing notes) reach drafting
 * automatically without a separate lookup — drafts usually follow a
 * read_thread call. Covers every distinct from/to/cc address across the
 * thread's messages; skips participants with no contacts row of kind
 * "person" (non-empty gist) and no contact-scoped memories. Returns "" when
 * nothing is known about anyone in the thread.
 */
async function buildParticipantContext(messages: ThreadMessage[]): Promise<string> {
  const addresses = [...normalizeAddressSet(messages.flatMap((m) => [m.from, ...m.to, ...m.cc]))];
  if (addresses.length === 0) return "";

  const contactRows = await db
    .select()
    .from(schema.contacts)
    .where(and(inArray(schema.contacts.address, addresses), eq(schema.contacts.kind, "person")));
  const contactByAddress = new Map(contactRows.map((c) => [c.address, c]));

  const memoryRows = await db
    .select()
    .from(schema.memories)
    .where(inArray(schema.memories.contactId, addresses));
  const memoriesByAddress = new Map<string, (typeof memoryRows)[number][]>();
  for (const row of memoryRows) {
    const key = row.contactId as string;
    const list = memoriesByAddress.get(key);
    if (list) list.push(row);
    else memoriesByAddress.set(key, [row]);
  }

  const lines: string[] = [];
  for (const address of addresses) {
    const contact = contactByAddress.get(address);
    const memories = memoriesByAddress.get(address) ?? [];
    const gist = contact?.gist.trim();
    if (!gist && memories.length === 0) continue;
    const label = contact?.displayName ? `${contact.displayName} <${address}>` : address;
    const gistPart = gist ? ` — ${gist}.` : "";
    const notes =
      memories.length > 0
        ? ` Notes: ${memories
            .slice(0, MAX_CONTACT_MEMORIES)
            .map((m) => m.content)
            .join("; ")}.`
        : "";
    lines.push(`[Known contact: ${label}${gistPart}${notes}]`);
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

function buildSearchMailTool(visibleCards: boolean): AgentTool {
  return defineTool({
    name: "search_mail",
    label: "Search mail",
    description:
      `Keyword search over the local mail index (subject, body, sender) across ALL connected ` +
      `email accounts, or one account via the account parameter (its address or id). Returns ` +
      `matches with their threadId (use with read_thread, and as the create-draft reply ` +
      `threadId) and messageId (use with save-attachment tools). The index mirrors roughly the ` +
      `last month of mail and can trail live mail by a few minutes — set refresh true only when ` +
      `the user asks about mail that may have just arrived.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
        account: {
          type: "string",
          description: "Optional: search only this connected account (email address or id).",
        },
        limit: { type: "number", description: `Max results (default ${DEFAULT_LIMIT}).` },
        refresh: {
          type: "boolean",
          description: "Pull the latest changes from the provider before searching.",
        },
      },
      required: ["query"],
    },
    execute: async (_id, params) => {
      const {
        query,
        account: accountRaw,
        limit: limitRaw,
        refresh,
      } = params as Record<string, unknown>;
      const { account, accounts, error } = await resolveAccountParam(accountRaw);
      if (error) return textResult(error);
      if (refresh === true) await refreshMirror(account, accounts);

      const limit = clampLimit(limitRaw);
      const hits = searchMail(String(query ?? ""), { accountId: account?.id, limit });
      if (hits.length === 0) {
        return textResult(
          `No local mail matches "${String(query)}"${account ? ` in ${account.name}` : ""}. ` +
            `The index covers roughly the last month of synced mail.`,
        );
      }

      const names = accountNameMap(accounts);
      const lines = hits.map((hit, i) => {
        const accountNote = account ? "" : ` [${names.get(hit.accountId) ?? hit.accountId}]`;
        return (
          `${i + 1}. ${hit.subject || "(no subject)"} — from ${hit.from}${accountNote}, ${hit.date}\n` +
          `   ${hit.snippet}\n` +
          `   threadId: ${hit.providerThreadId} | messageId: ${hit.providerMessageId}`
        );
      });

      const cardHits: EmailHit[] = hits.map((hit) => ({
        messageId: hit.providerMessageId,
        threadId: hit.providerThreadId,
        accountId: hit.accountId,
        subject: hit.subject,
        from: hit.from,
        to: hit.to,
        date: hit.date,
        snippet: hit.snippet,
      }));
      const card: AgentCard = {
        kind: "email_hits",
        ...(account ? { account: toCardAccount(account) } : {}),
        query: String(query ?? ""),
        hits: cardHits,
        ...(hits.length === limit ? { truncated: true } : {}),
      };
      const note = visibleCards
        ? "\n\n[The user sees these hits as a card in the conversation. Don't re-list them in " +
          "your reply — give your takeaway and say which threads are worth opening.]"
        : "";
      return textResult(lines.join("\n") + note, card);
    },
  });
}

function buildReadThreadTool(visibleCards: boolean): AgentTool {
  return defineTool({
    name: "read_thread",
    label: "Read mail thread",
    description:
      `Read one email thread in full from the local mail index, oldest message first — always ` +
      `use this before summarizing a thread or drafting a reply. threadId is the provider ` +
      `thread id from search_mail, list_threads or list_waiting_threads results; pass account ` +
      `when you know which account the thread lives in.`,
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Provider thread id." },
        account: {
          type: "string",
          description: "Optional: the connected account (email address or id) the thread is in.",
        },
      },
      required: ["threadId"],
    },
    execute: async (_id, params) => {
      const { threadId, account: accountRaw } = params as Record<string, unknown>;
      const { account, accounts, error } = await resolveAccountParam(accountRaw);
      if (error) return textResult(error);

      const detail = getThreadDetail(String(threadId ?? ""), account?.id);
      if (!detail) {
        return textResult(
          `No thread ${String(threadId)} in the local mail index` +
            `${account ? ` for ${account.name}` : ""}. Check the id against a search_mail or ` +
            `list_threads result; mail older than the sync window is not indexed.`,
        );
      }

      const owner = accounts.find((a) => a.id === detail.accountId);
      const header =
        `Thread "${detail.subject || "(no subject)"}" in ${owner?.name ?? detail.accountId} — ` +
        `${detail.messages.length} message(s), threadId: ${detail.providerThreadId}`;
      const blocks = detail.messages.map((m) => {
        const cc = m.cc.length > 0 ? `\nCc: ${m.cc.join(", ")}` : "";
        return (
          `From: ${m.from}\nTo: ${m.to.join(", ")}${cc}\nDate: ${m.date}` +
          `\nmessageId: ${m.providerMessageId}\n\n${truncateBody(m.bodyText)}`
        );
      });

      const card: AgentCard = {
        kind: "email_thread",
        ...(owner ? { account: toCardAccount(owner) } : {}),
        threadId: detail.providerThreadId,
        subject: detail.subject,
        messages: detail.messages.map((m) => ({
          from: m.from,
          to: m.to,
          ...(m.cc.length > 0 ? { cc: m.cc } : {}),
          date: m.date,
          body: truncateBody(m.bodyText),
        })),
      };
      const participantContext = await buildParticipantContext(detail.messages);
      const note = visibleCards
        ? "\n\n[The user sees this thread as a card in the conversation. Don't re-print or quote " +
          "the messages in your reply — summarize or answer directly.]"
        : "";
      return textResult(
        `${header}\n\n${blocks.join("\n\n---\n\n")}${participantContext}${note}`,
        card,
      );
    },
  });
}

const listThreadsTool: AgentTool = defineTool({
  name: "list_threads",
  label: "List mail threads",
  description:
    `List recent email threads from the local mail index, newest first, across all connected ` +
    `accounts or one account. filter "unread" keeps threads with unread mail; ` +
    `"needs_attention" keeps threads the enrichment pipeline judged as needing a reply or ` +
    `action, or urgent. Each line carries the thread's one-line gist and triage when ` +
    `available — use this to scan an inbox before deciding what to read in full, and use the ` +
    `printed threadId with read_thread.`,
  parameters: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description: "Optional: list only this connected account (email address or id).",
      },
      filter: {
        type: "string",
        enum: ["recent", "unread", "needs_attention"],
        description: 'Which threads to list (default "recent").',
      },
      limit: { type: "number", description: `Max threads (default ${DEFAULT_LIMIT}).` },
      refresh: {
        type: "boolean",
        description: "Pull the latest changes from the provider before listing.",
      },
    },
    required: [],
  },
  execute: async (_id, params) => {
    const {
      account: accountRaw,
      filter: filterRaw,
      limit: limitRaw,
      refresh,
    } = params as Record<string, unknown>;
    const { account, accounts, error } = await resolveAccountParam(accountRaw);
    if (error) return textResult(error);
    if (refresh === true) await refreshMirror(account, accounts);

    const filter: ThreadFilter =
      filterRaw === "unread" || filterRaw === "needs_attention" ? filterRaw : "recent";
    const threads = listThreadOverviews({
      accountId: account?.id,
      filter,
      limit: clampLimit(limitRaw),
    });
    if (threads.length === 0) {
      return textResult(
        `No ${filter === "recent" ? "" : `${filter} `}threads in the local mail index` +
          `${account ? ` for ${account.name}` : ""}.`,
      );
    }

    const names = accountNameMap(accounts);
    const lines = threads.map((t, i) => {
      const accountNote = account ? "" : ` [${names.get(t.accountId) ?? t.accountId}]`;
      const flags = [
        t.hasUnread ? "unread" : null,
        t.lastFromMe ? "last message from user" : null,
        t.triage ? `triage: ${t.triage}` : null,
        t.urgency && t.urgency !== "normal" ? `urgency: ${t.urgency}` : null,
        t.deadline ? `deadline: ${t.deadline}` : null,
      ].filter(Boolean);
      return (
        `${i + 1}. ${t.subject || "(no subject)"}${accountNote} — ${t.messageCount} msg, ` +
        `last ${t.lastMessageAt}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}\n` +
        `${t.gist ? `   ${t.gist}\n` : ""}   threadId: ${t.providerThreadId}`
      );
    });
    return textResult(lines.join("\n"));
  },
});

const listSentTool: AgentTool = defineTool({
  name: "list_sent_messages",
  label: "List sent messages",
  description:
    `List the newest messages the user themselves sent, newest first, with each message's ` +
    `threadId for read_thread. Serves from the local mail index, across all connected ` +
    `accounts or one account via the account parameter. Use this (not search_mail) when the ` +
    `task is about the user's own outgoing mail — reviewing what they sent today, studying ` +
    `their writing.`,
  parameters: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description: "Optional: list only this connected account (email address or id).",
      },
      limit: { type: "number", description: `Max messages (default ${DEFAULT_LIMIT}).` },
    },
    required: [],
  },
  execute: async (_id, params) => {
    const { account: accountRaw, limit: limitRaw } = params as Record<string, unknown>;
    const { account, accounts, error } = await resolveAccountParam(accountRaw);
    if (error) return textResult(error);

    const limit = clampLimit(limitRaw);
    const targets = account ? [account] : accounts;
    const names = accountNameMap(accounts);
    const rows = targets
      .flatMap((a) => listSentMessages(a.id, limit).map((m) => ({ ...m, accountId: a.id })))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
    if (rows.length === 0) {
      return textResult(
        `No sent messages${account ? ` for ${account.name}` : ""} in the local mail index — ` +
          `the mirror may still be syncing, or there is no recent sent mail.`,
      );
    }
    const lines = rows.map((m, i) => {
      const accountNote = account ? "" : ` [${names.get(m.accountId) ?? m.accountId}]`;
      return (
        `${i + 1}. ${m.subject || "(no subject)"} — to ${m.to.join(", ") || "(unknown)"}${accountNote}, ${m.date}\n` +
        `   ${m.snippet}\n   threadId: ${m.providerThreadId}`
      );
    });
    return textResult(lines.join("\n"));
  },
});

const listDraftsTool: AgentTool = defineTool({
  name: "list_drafts",
  label: "List drafts",
  description:
    `List the unsent drafts currently sitting in each connected account's Drafts folder ` +
    `(live from the provider, briefly cached) — subject, recipients, date, snippet, and the ` +
    `draft's threadId when it replies to a conversation. Use it to review what is drafted ` +
    `but not sent; the user sends drafts themselves from their mail client or the Drafts page.`,
  parameters: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description: "Optional: list only this connected account (email address or id).",
      },
    },
    required: [],
  },
  execute: async (_id, params) => {
    const { account: accountRaw } = params as Record<string, unknown>;
    const { account, accounts, error } = await resolveAccountParam(accountRaw);
    if (error) return textResult(error);

    const targets = (account ? [account] : accounts).filter(
      (a) => getDraftProvider(a.app) !== null,
    );
    if (targets.length === 0) {
      return textResult(
        account
          ? `${account.name} has no drafts support.`
          : "No connected account supports drafts.",
      );
    }

    const sections = await Promise.all(
      targets.map(async (a) => {
        try {
          const drafts = await listDraftsCached(a);
          if (drafts.length === 0) return `${a.name}: no drafts.`;
          const lines = drafts.map((d, i) => {
            const thread = d.threadId ? ` | threadId: ${d.threadId}` : "";
            return (
              `${i + 1}. ${d.subject || "(no subject)"} — to ${d.to || "(no recipients)"}, ${d.date}\n` +
              `   ${d.snippet ?? ""}\n   draftId: ${d.id}${thread}`
            );
          });
          return `${a.name}:\n${lines.join("\n")}`;
        } catch (error) {
          return `${a.name}: listing drafts failed (${errorMessage(error)}).`;
        }
      }),
    );
    return textResult(sections.join("\n\n"));
  },
});

const MAX_LOOKUP_RESULTS = 10;

const lookupContactTool: AgentTool = defineTool({
  name: "lookup_contact",
  label: "Look up contact",
  description:
    `Look up what's known locally about a correspondent by email address or name fragment — ` +
    `relationship category, one-line gist, message counts, and any contact-scoped memories. ` +
    `read_thread already surfaces this automatically for a thread's participants; use this ` +
    `tool to check someone outside a thread, or when that automatic context wasn't enough.`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "An email address (exact or partial) or a name fragment to search for.",
      },
    },
    required: ["query"],
  },
  execute: async (_id, params) => {
    const { query } = params as { query?: string };
    const trimmed = (query ?? "").trim();
    if (!trimmed) return textResult("Provide an email address or name to look up.");

    const needle = `%${trimmed.toLowerCase()}%`;
    const rows = await db
      .select()
      .from(schema.contacts)
      .where(or(like(schema.contacts.address, needle), like(schema.contacts.displayName, needle)))
      .orderBy(desc(schema.contacts.lastContactAt))
      .limit(MAX_LOOKUP_RESULTS);
    if (rows.length === 0) return textResult(`No local contact matches "${trimmed}".`);

    // Real correspondents first — bulk/newsletter senders sort after, within the same cap.
    const sorted = [...rows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "person" ? -1 : 1));

    const addresses = sorted.map((c) => c.address);
    const memoryRows = await db
      .select()
      .from(schema.memories)
      .where(inArray(schema.memories.contactId, addresses));
    const memoriesByAddress = new Map<string, (typeof memoryRows)[number][]>();
    for (const m of memoryRows) {
      const key = m.contactId as string;
      const list = memoriesByAddress.get(key);
      if (list) list.push(m);
      else memoriesByAddress.set(key, [m]);
    }

    const blocks = sorted.map((c) => {
      const label = c.displayName ? `${c.displayName} <${c.address}>` : c.address;
      const aggregates =
        `${c.messageCount} message(s), ${c.sentCount} sent, ` +
        `last contact ${c.lastContactAt || "unknown"}`;
      const memories = memoriesByAddress.get(c.address) ?? [];
      const notes =
        memories.length > 0
          ? `\n  Notes:\n${memories.map((m) => `  - ${m.content}`).join("\n")}`
          : "";
      return `${label} — ${c.kind}, ${c.category}${c.gist ? `\n  ${c.gist}` : ""}\n  ${aggregates}${notes}`;
    });
    return textResult(blocks.join("\n\n"));
  },
});

/**
 * The mirror-backed read tools every agent surface shares (main chat,
 * delegate workers, voice learning). visibleCards marks surfaces that render
 * tool cards to the user (chat and reopened automation transcripts): the
 * card-emitting tools then tell the model not to restate card contents.
 * One-shot workers leave it off — their cards render nowhere, so their
 * reports must carry the content.
 */
export function buildMailReadTools({
  visibleCards = false,
}: {
  visibleCards?: boolean;
} = {}): AgentTool[] {
  return [
    buildSearchMailTool(visibleCards),
    buildReadThreadTool(visibleCards),
    listThreadsTool,
    listSentTool,
    listDraftsTool,
    lookupContactTool,
  ];
}
