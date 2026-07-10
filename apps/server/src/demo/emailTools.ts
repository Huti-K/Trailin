import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentCard, ConnectedAccount } from "@trailin/shared";
import { toCardAccount } from "../agent/cards.js";
import { getAccountDescriptions } from "../db/settings.js";
import { snippetFrom } from "../email/textUtils.js";
import { accountSlug, buildDraftTool, type EmailToolset } from "../pipedream/mcp.js";
import { demoDraftProvider } from "./demoDrafts.js";
import { getDemoAccounts } from "./accounts.js";
import { daysAgo } from "./content.js";
import { MAILBOX, resolveThread, type DemoEmailMessage, type DemoThread } from "./mailbox.js";

/**
 * Demo mode's email toolset: search/read/draft tools backed entirely by the
 * seeded MAILBOX (demo/mailbox.ts) instead of a live Pipedream/Gmail
 * connection. The demo always has exactly 3 Gmail accounts, so tool names
 * always carry the account-slug suffix (no need for mcp.ts's needsSuffix
 * check — there's never just one).
 */

const MAX_RESULTS_DEFAULT = 10;
const MAX_RESULTS_HARD_CAP = 25;
const SNIPPET_LENGTH = 200;

function purposeNote(purpose: string | undefined): string {
  return purpose?.trim() ? ` This connection is used for: ${purpose.trim()}.` : "";
}

function messageDate(message: DemoEmailMessage): Date {
  return daysAgo(message.daysAgo, message.hour, message.minute ?? 0);
}

/** A parsed demo-Gmail query — see buildFindEmailTool's description for the supported syntax. */
interface ParsedQuery {
  general: string[];
  from: string[];
  to: string[];
  subject: string[];
  newerThanDays?: number;
  olderThanDays?: number;
}

// An operator+quoted-value token (from:"Thomas Brandt") must be kept
// together — without the first alternative, the tokenizer would split it at
// the space inside the quotes and neither half could ever match.
const QUERY_TOKEN_RE = /[a-zA-Z_]+:"[^"]*"|"[^"]*"|\S+/g;
const DAY_SUFFIX_RE = /^(\d+)d$/;

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * A small, forgiving subset of Gmail search syntax (see buildFindEmailTool's
 * description for exactly what's supported). Never throws — anything it
 * doesn't recognize (an unsupported operator, a malformed newer_than value)
 * is just dropped rather than failing the search.
 */
function parseQuery(q: string): ParsedQuery {
  const parsed: ParsedQuery = { general: [], from: [], to: [], subject: [] };
  for (const raw of q.match(QUERY_TOKEN_RE) ?? []) {
    const opMatch = /^([a-zA-Z_]+):(.+)$/.exec(raw);
    if (opMatch) {
      const op = (opMatch[1] ?? "").toLowerCase();
      const value = unquote(opMatch[2] ?? "").toLowerCase().trim();
      if (!value) continue;
      if (op === "from") parsed.from.push(value);
      else if (op === "to") parsed.to.push(value);
      else if (op === "subject") parsed.subject.push(value);
      else if (op === "newer_than") {
        const days = DAY_SUFFIX_RE.exec(value)?.[1];
        if (days) parsed.newerThanDays = Number(days);
      } else if (op === "older_than") {
        const days = DAY_SUFFIX_RE.exec(value)?.[1];
        if (days) parsed.olderThanDays = Number(days);
      }
      // Any other operator (label:, in:, has:, is:, before:, after:, ...) is
      // ignored rather than failing.
      continue;
    }
    const term = unquote(raw).toLowerCase().trim();
    if (term) parsed.general.push(term);
  }
  return parsed;
}

function matchesQuery(parsed: ParsedQuery, thread: DemoThread, message: DemoEmailMessage, date: Date): boolean {
  const from = message.from.toLowerCase();
  const to = message.to.join(" ").toLowerCase();
  const cc = (message.cc ?? []).join(" ").toLowerCase();
  const subject = thread.subject.toLowerCase();
  const body = message.body.toLowerCase();
  const haystack = [from, to, cc, subject, body].join(" ");

  if (!parsed.general.every((term) => haystack.includes(term))) return false;
  if (!parsed.from.every((term) => from.includes(term))) return false;
  if (!parsed.to.every((term) => to.includes(term))) return false;
  if (!parsed.subject.every((term) => subject.includes(term))) return false;

  const now = Date.now();
  if (parsed.newerThanDays != null && date.getTime() < now - parsed.newerThanDays * 86_400_000) {
    return false;
  }
  if (parsed.olderThanDays != null && date.getTime() > now - parsed.olderThanDays * 86_400_000) {
    return false;
  }
  return true;
}

interface MatchedMessage {
  thread: DemoThread;
  message: DemoEmailMessage;
  /** 0-based position of `message` within `thread.messages`. */
  index: number;
  date: Date;
}

function searchMailbox(
  accountId: string,
  q: string,
  maxResults: number,
): { total: number; results: MatchedMessage[] } {
  const parsed = parseQuery(q);
  const hits: MatchedMessage[] = [];
  for (const thread of MAILBOX) {
    if (thread.accountId !== accountId) continue;
    thread.messages.forEach((message, index) => {
      const date = messageDate(message);
      if (matchesQuery(parsed, thread, message, date)) hits.push({ thread, message, index, date });
    });
  }
  hits.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { total: hits.length, results: hits.slice(0, maxResults) };
}

function formatSnippet(body: string): string {
  return snippetFrom(body, SNIPPET_LENGTH);
}

function formatHit(hit: MatchedMessage): string {
  const { thread, message, index, date } = hit;
  return [
    `messageId: ${thread.id}-m${index + 1}`,
    `threadId: ${thread.id}`,
    `date: ${date.toISOString()}`,
    `from: ${message.from}`,
    `to: ${message.to.join(", ")}`,
    `subject: ${thread.subject}`,
    `snippet: ${formatSnippet(message.body)}`,
  ].join("\n");
}

function buildFindEmailTool(account: ConnectedAccount, slug: string, purpose: string | undefined): AgentTool {
  return {
    name: `gmail-find-email__${slug}`,
    label: "Find email",
    description:
      `Search this Gmail account's message history with a practical subset of Gmail's query ` +
      `syntax:\n` +
      `- Bare words are ANDed, case-insensitive, and matched against from/to/cc/subject/body.\n` +
      `- "Quoted phrases" match exactly as written, e.g. "Thomas Brandt".\n` +
      `- from:/to:/subject: restrict a term to that field; the value may be quoted or bare ` +
      `(from:"Thomas Brandt" or from:t.brandt@acme-gmbh.de).\n` +
      `- newer_than:Nd / older_than:Nd filter by message age in days, e.g. newer_than:7d.\n` +
      `- Any other operator (label:, in:, has:, is:, before:, after:, ...) is ignored rather ` +
      `than failing.\n` +
      `- An empty query, or one that is only unknown operators, matches everything.\n\n` +
      `Matches individual messages — a thread can produce several hits. Results are newest ` +
      `first, one block per message with messageId, threadId, date, from, to, subject, and a ` +
      `~200-character snippet of the body. Returns up to ${MAX_RESULTS_DEFAULT} matches by ` +
      `default (pass maxResults to raise this, up to ${MAX_RESULTS_HARD_CAP}); if there are ` +
      `more matches than shown, the result says so.\n\n` +
      `Acts as the connected account: ${account.name}.${purposeNote(purpose)}`,
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Gmail-style search query. See the tool description for supported syntax.",
        },
        maxResults: {
          type: "number",
          description: `Maximum matches to return (default ${MAX_RESULTS_DEFAULT}, hard cap ${MAX_RESULTS_HARD_CAP}).`,
        },
      },
      required: ["q"],
    } as AgentTool["parameters"],
    execute: async (_toolCallId, params) => {
      const { q, maxResults } = params as { q: string; maxResults?: number };
      const limit = Math.max(1, Math.min(maxResults ?? MAX_RESULTS_DEFAULT, MAX_RESULTS_HARD_CAP));
      const { total, results } = searchMailbox(account.id, q ?? "", limit);
      const card: AgentCard = {
        kind: "email_hits",
        account: toCardAccount(account),
        query: q,
        hits: results.map((hit) => ({
          messageId: `${hit.thread.id}-m${hit.index + 1}`,
          threadId: hit.thread.id,
          subject: hit.thread.subject,
          from: hit.message.from,
          to: hit.message.to,
          date: hit.date.toISOString(),
          snippet: formatSnippet(hit.message.body),
        })),
        truncated: total > results.length,
      };
      if (total === 0) {
        return {
          content: [{ type: "text", text: `No messages match "${q}".` }],
          details: card,
        };
      }
      const summary =
        total > results.length
          ? `showing ${results.length} of ${total} matches — refine the query`
          : `${total} match${total === 1 ? "" : "es"}`;
      const text = `${summary}\n\n${results.map(formatHit).join("\n\n")}`;
      return { content: [{ type: "text", text }], details: card };
    },
  };
}

function buildGetThreadTool(account: ConnectedAccount, slug: string, purpose: string | undefined): AgentTool {
  return {
    name: `gmail-get-thread__${slug}`,
    label: "Get email thread",
    description:
      `Fetch a full email thread from this Gmail account: the subject, then every message ` +
      `chronologically with from, to, cc, date, and the full body. Pass the threadId from ` +
      `gmail-find-email__${slug}, or a messageId of the form "<threadId>-mN" — the "-mN" ` +
      `suffix is stripped automatically.\n\n` +
      `Acts as the connected account: ${account.name}.${purposeNote(purpose)}`,
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: `Thread id (or a messageId of the form "<threadId>-mN") from gmail-find-email__${slug}.`,
        },
      },
      required: ["threadId"],
    } as AgentTool["parameters"],
    execute: async (_toolCallId, params) => {
      const { threadId } = params as { threadId: string };
      const threads = MAILBOX.filter((t) => t.accountId === account.id);
      const thread = resolveThread(threads, threadId);
      if (!thread) {
        throw new Error(
          `No thread found for id "${threadId}" in ${account.name}'s mailbox. It may belong ` +
            `to a draft that has no thread in the mailbox.`,
        );
      }
      const messages = thread.messages
        .map((message, index) => {
          const lines = [
            `--- Message ${index + 1} ---`,
            `From: ${message.from}`,
            `To: ${message.to.join(", ")}`,
          ];
          if (message.cc?.length) lines.push(`Cc: ${message.cc.join(", ")}`);
          lines.push(`Date: ${messageDate(message).toISOString()}`, "", message.body);
          return lines.join("\n");
        })
        .join("\n\n");
      const text = `Subject: ${thread.subject}\n\n${messages}`;
      const card: AgentCard = {
        kind: "email_thread",
        account: toCardAccount(account),
        threadId: thread.id,
        subject: thread.subject,
        messages: thread.messages.map((message) => ({
          from: message.from,
          to: message.to,
          ...(message.cc?.length ? { cc: message.cc } : {}),
          date: messageDate(message).toISOString(),
          body: message.body,
        })),
      };
      return { content: [{ type: "text", text }], details: card };
    },
  };
}

/**
 * Build the demo mailbox's email tools: one find/get/draft trio per fake
 * account, all reading from and (for drafts) writing to the seeded demo
 * state rather than a real Pipedream session.
 */
export async function buildDemoEmailToolset(): Promise<EmailToolset> {
  const accounts = getDemoAccounts();
  const descriptions = await getAccountDescriptions();
  const purposeByAccount = new Map(descriptions.map((d) => [d.accountId, d.text]));

  const tools: AgentTool[] = [];
  const readTools: AgentTool[] = [];

  for (const account of accounts) {
    const slug = accountSlug(account);
    const purpose = purposeByAccount.get(account.id);

    const findTool = buildFindEmailTool(account, slug, purpose);
    const getThreadTool = buildGetThreadTool(account, slug, purpose);
    // Never in readTools: background delegate workers must not create drafts.
    const draftTool = buildDraftTool(account, `gmail-create-draft__${slug}`, demoDraftProvider);

    tools.push(findTool, getThreadTool, draftTool);
    readTools.push(findTool, getThreadTool);
  }

  return { tools, readTools, close: async () => {} };
}
