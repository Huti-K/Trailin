import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { LANGUAGE_ENGLISH_NAMES, type Language } from "@trailin/shared";
import { db, schema } from "../db/index.js";
import { getEmailWriteSetting, getLanguageSetting, getTimezoneSetting } from "../db/settings.js";
import { modelRegistry, resolveActiveModel } from "../llm/registry.js";
import { loadEmailTools, type EmailToolset } from "../pipedream/mcp.js";
import { buildBriefingTool } from "./briefingTool.js";
import { parseStoredCards } from "./cards.js";
import { buildDelegateTool } from "./delegate.js";
import { buildKnowledgeContext, buildKnowledgeTools } from "./knowledgeTools.js";
import { buildVoiceContext } from "./voice.js";
import { buildVoiceLearnTool } from "./voiceLearn.js";
import { buildWaitingThreadsTool } from "./waitingTools.js";

const SYSTEM_PROMPT = `You are Trailin, a personal email assistant. You have tools for the user's
connected accounts — email (Gmail / Outlook) and possibly other apps — provided through
Pipedream Connect.

Guidelines:
- Several accounts may be connected. Every tool's description says which account it acts as
  ("Acts as the connected account: …"); with more than one account of the same app, tool names
  carry an account suffix (e.g. gmail-find-email__work). Pick the account the user means; when
  it's ambiguous and the action matters (sending, deleting), ask instead of guessing.
- If you have no email tools, tell the user to finish the email setup under Settings → Connect email.
- Prefer reading and summarizing over acting. Look things up before you claim them.
- Never send, reply to, forward or delete an email unless the user's request explicitly asks for it.
  When composing, show the draft content in your answer so the user can see exactly what went out.
- Keep answers short and skimmable, and let plain prose carry most of it. Your replies render as
  Markdown, so use it — but only where it genuinely helps the reader: **bold** for the few words
  that matter, bullet or numbered lists for sets of items (inbox summaries: **sender**: subject,
  one-line gist), \`code\` for exact values like email addresses or filenames, and tables only for
  data that is truly tabular. For a short or single-idea answer, a sentence or two beats a decorated
  one — skip headings, bold and bullets. Never wrap a whole reply in a list or bold half the words.
- Write like a person, not a chatbot. This matters most in email drafts and summaries. Lead with the
  point and cut filler openers and closers ("I hope this email finds you well", "I wanted to reach out",
  "I hope this helps", "Let me know if you have any questions"), sycophancy ("Great question", "Thanks so
  much for reaching out"), and hollow wrap-ups ("Overall…", "Exciting times ahead"). Normal greetings and
  sign-offs ("Hi Sarah," / "Best,") are fine.
- Prefer plain words over the usual LLM tells: delve, leverage, utilize, foster, seamless, robust,
  streamline, underscore, testament, tapestry, navigate, boasts, vibrant, and "stands/serves as" (just say
  "is" or "has"). Don't force ideas into threes, "not just X but Y" parallelisms, or "-ing" tails that fake
  depth ("…ensuring…", "…highlighting…"), and don't over-hedge ("could potentially possibly"). Vary
  sentence length, and use no em or en dashes; a comma, period, colon, or parentheses does the job.
- In summaries, say what's actually in the source and attribute it concretely (not "experts say" or
  "studies show"); when something isn't known, say so instead of inventing plausible filler. Match the
  user's own voice in email drafts and keep summaries neutral, and don't add opinions or personality that
  aren't theirs.
- When you compose a digest or summary that pulls several items together, don't ship your first
  pass. Reread it once as if you were hunting for the AI tells above, plus: forced groups of three,
  "not just X but Y" parallelisms, "-ing" tails that fake depth ("…ensuring…", "…highlighting…"),
  false ranges ("from X to Y" where X and Y aren't a real scale), synonym-cycling the same noun,
  bolded inline-header lists, and generic upbeat closers. Fix what you find, then give only the
  finished version. Do this silently in the same turn: the reader sees the final digest, never the
  rough pass or notes about it. Skip it for short conversational replies — and for email drafts,
  whose bodies get a mechanical humanizer edit at save time anyway.
- Timestamps from tools are usually UTC; present them in a human-friendly way.
- You have a long-term memory: saved entries are listed at the end of this prompt. When the
  user asks you to remember something, or states a lasting fact or preference, save it with
  memory_save. Don't save one-off task details or things already in memory. When a saved fact
  changes, update the existing entry with memory_update (using the id shown in brackets)
  instead of saving a second, contradicting entry. Use memory_delete only when the user asks
  you to forget something. Memory is for short standing facts only — longer-form knowledge
  (background on a correspondent, a thread summary, research findings) belongs in the library
  as a note instead: save it with library_write. Facts that only apply to one connected account
  (a client of one company, a per-inbox preference) should be saved with the account parameter so
  they're grouped under that account, and account-scoped entries in the list below only apply
  when acting as that account. Account-scoped memories also include writing-style directives —
  learned from that account's sent mail by voice_learn, or written by the user — covering things
  like typical greeting, sign-off, tone, length, and language; imitate them whenever you draft as
  that account.
- The user keeps a local document library (PDFs, notes) for you — titles are listed at the end
  of this prompt. Check it with library_search whenever a question or task could plausibly be
  covered by one of those documents, not only when the user says "my documents"; read the full
  match with library_read and say which document you used. On scheduled automation runs, search
  the library first if the task relates to any listed document.
- Ground every email draft in real context: before drafting a reply, read the full thread (not just
  the newest message), and pull anything relevant from memory or the library (who the correspondent
  is, prior agreements, standing facts) so the draft is specific and consistent with what was
  already said.
- For work that spans many independent lookups (a digest over many threads, several senders'
  histories, cross-checking documents), fan the lookups out with the delegate tool and synthesize
  the workers' reports instead of doing every lookup serially yourself.
- When the user asks about a person ("find everything from X", "my history with X"), search every
  connected account, not just the obvious one — the same person can show up in several inboxes.
  Query both the name and any address you know for them, and for a broad sweep fan the per-account
  searches out with delegate. Present the hits as one timeline, newest first (date, account,
  subject: one-line gist), and say which threads look worth opening.
- When asked to summarize an email thread or chain, fetch the whole thread first (never just the
  latest message), then summarize it chronologically: who wants what, what was agreed or decided,
  what changed along the way, what is still open, and what (if anything) is waiting on the user.
- Past scheduled-automation runs (morning briefings, end-of-day learnings) are on record: use
  automation_history to find runs and automation_run_read for a run's full text whenever the user
  references "your briefing", something "you flagged", or what an automation found on some day.
- list_waiting_threads shows, per Gmail account, threads where the user sent the last message and
  nobody has replied for a day or more. Use it when the user asks what they're waiting on, for
  follow-up checks, and in briefings; for long-overdue threads, offer a nudge draft.
- compose_briefing renders a structured, interactive briefing card (grouped by how urgently each
  message needs the user, with per-thread actions). Use it whenever you produce a multi-message
  inbox digest, and give every item its real threadId so the card's actions work. When you call
  it, the card IS the report: close with two or three sentences, never a re-listing of the items.
- To work with an email attachment (a PDF someone sent, a document to summarize), save it into the
  document library with that account's save-attachment tool, then find it with library_search and
  read it with library_read once indexed.
- Draft bodies go through a humanizer edit before they are saved. When the create-draft result
  reports a final text different from what you submitted, quote that saved version in your answer,
  never your pre-pass text.`;

/** Intl locale used for the system prompt's date/time, keyed by the app's language setting. */
const DATE_LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: "en-US",
  de: "de-DE",
};

/** e.g. "Thu, Jul 9, 2026, 10:31" — rendered in the given IANA timezone and locale. */
function formatNow(timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

/** The base prompt plus the Settings rules (scheduled runs rely on them too). */
export async function buildSystemPrompt(): Promise<string> {
  let prompt = SYSTEM_PROMPT;

  if (!(await getEmailWriteSetting())) {
    prompt += `
- Read-only mode is on: you only have tools that read, search or create drafts. You cannot send,
  delete or change anything. If the user asks for such an action, explain that read-only mode can
  be turned off under Settings → Connect email.`;
  }

  const language = (await getLanguageSetting()) ?? "en";
  if (language !== "en") {
    prompt += `
- Always answer in ${LANGUAGE_ENGLISH_NAMES[language]}, no matter what language the user's message
  or their emails are written in. Quoted email text and draft emails may keep their own language.`;
  }

  const timezone = (await getTimezoneSetting()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateLocale = DATE_LOCALE_BY_LANGUAGE[language] ?? "en-US";
  prompt += `
- Current date and time: ${formatNow(timezone, dateLocale)} (${timezone}). The user lives in this timezone —
  present all times in it and interpret relative dates ("today", "next Monday") against it.`;

  prompt += await buildVoiceContext();
  prompt += await buildKnowledgeContext();
  return prompt;
}

export interface AgentSession {
  agent: Agent;
  toolset: EmailToolset;
}

/** A live session plus when it was last touched, for idle/LRU eviction. */
interface SessionEntry {
  session: AgentSession;
  lastUsed: number;
}

// Idle sessions keep their MCP connections open for nothing; cap both how
// long one can sit unused and how many can exist at once.
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX_COUNT = 20;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, SessionEntry>();
// In-flight session creations, keyed by conversationId — lets two concurrent
// requests for a brand-new conversation share one creation instead of each
// opening (and one of them leaking) its own MCP session.
const pendingSessions = new Map<string, Promise<AgentSession>>();

/** Same disposal path resetSessions()/disposeSession() use, for idle/LRU eviction too. */
function evictSession(conversationId: string, entry: SessionEntry): void {
  sessions.delete(conversationId);
  void entry.session.toolset.close().catch(() => {});
}

function sweepSessions(): void {
  const now = Date.now();
  for (const [conversationId, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_IDLE_TTL_MS) evictSession(conversationId, entry);
  }
  if (sessions.size > SESSION_MAX_COUNT) {
    const byLastUsed = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [conversationId, entry] of byLastUsed.slice(0, sessions.size - SESSION_MAX_COUNT)) {
      evictSession(conversationId, entry);
    }
  }
}

const sweepTimer = setInterval(sweepSessions, SESSION_SWEEP_INTERVAL_MS);
sweepTimer.unref();

/** Fixed at a balanced default, not user-configurable — "medium" wherever the model can reason at all. */
function resolveThinkingLevel(model: { reasoning: boolean }): "off" | "low" | "medium" | "high" {
  return model.reasoning ? "medium" : "off";
}

async function buildAgent(toolset: EmailToolset, history: Message[] = []): Promise<Agent> {
  // Active model comes from Settings (SQLite), falling back to .env.
  const model = await resolveActiveModel();
  return new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(),
      model,
      thinkingLevel: resolveThinkingLevel(model),
      // Email tools from Pipedream, the local memory/library tools, and the
      // delegate fan-out tool for spreading independent lookups across
      // parallel background workers.
      tools: [
        ...toolset.tools,
        ...buildKnowledgeTools(),
        buildDelegateTool(toolset),
        buildVoiceLearnTool(),
        buildWaitingThreadsTool(),
        buildBriefingTool(),
      ],
      messages: history,
    },
    // Route model calls through the registry so stored credentials apply
    // (subscription OAuth with auto-refresh, saved API keys, then env vars).
    streamFn: (model, context, options) => modelRegistry.streamSimple(model, context, options),
  });
}

/**
 * Rebuild a conversation's prior turns from the message log, so continuing an
 * older conversation (after a restart or session reset) keeps the agent's
 * memory. The model history is intentionally reconstructed as text; persisted
 * tool activity is presentation metadata for the chat UI.
 */
async function loadHistory(conversationId: string): Promise<Message[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(schema.messages.createdAt);
  if (rows.length === 0) return [];

  const model = await resolveActiveModel();
  const zeroUsage = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const messages: Message[] = [];
  for (const row of rows) {
    let content = row.content.trim();
    if (!content) continue;
    const timestamp = Date.parse(row.createdAt) || Date.now();
    if (row.role === "user") {
      messages.push({ role: "user", content, timestamp });
    } else {
      // Tool results aren't persisted, but a turn's created drafts are (via
      // its cards) — reattach their ids so the rebuilt session can still
      // refer to "the draft" precisely when the user comes back to refine it.
      const draftNotes = (parseStoredCards(row.cards) ?? []).flatMap(({ card }) =>
        card.kind === "email_draft"
          ? [
              `[This turn created draft ${card.draft.draftId}` +
                (card.account ? ` in ${card.account.name}` : "") +
                (card.draft.threadId ? ` on thread ${card.draft.threadId}` : "") +
                `, subject "${card.draft.subject}".]`,
            ]
          : [],
      );
      if (draftNotes.length > 0) content += `\n\n${draftNotes.join("\n")}`;
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp,
      });
    }
  }
  return messages;
}

/** One pi Agent per conversation; context lives in process memory. */
export async function getOrCreateSession(conversationId: string): Promise<AgentSession> {
  const existing = sessions.get(conversationId);
  if (existing) {
    existing.lastUsed = Date.now();
    // The current date/time (and memory/library context) can go stale on a
    // long-lived session — recompute the system prompt before every prompt.
    existing.session.agent.state.systemPrompt = await buildSystemPrompt();
    existing.session.agent.state.thinkingLevel = resolveThinkingLevel(
      existing.session.agent.state.model,
    );
    return existing.session;
  }

  // Two concurrent requests for the same new conversationId must share one
  // creation — otherwise both pass the check above and each opens its own
  // MCP session, leaking whichever one loses the race to `sessions.set`.
  const inFlight = pendingSessions.get(conversationId);
  if (inFlight) return inFlight;

  const creation = (async (): Promise<AgentSession> => {
    const [toolset, history] = await Promise.all([loadEmailTools(), loadHistory(conversationId)]);
    const session: AgentSession = { agent: await buildAgent(toolset, history), toolset };
    sessions.set(conversationId, { session, lastUsed: Date.now() });
    if (sessions.size > SESSION_MAX_COUNT) sweepSessions();
    return session;
  })();
  pendingSessions.set(conversationId, creation);
  try {
    return await creation;
  } finally {
    pendingSessions.delete(conversationId);
  }
}

/** Drop all in-memory agent sessions (e.g. after auth or model changes). */
export async function resetSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((entry) => entry.session.toolset.close().catch(() => {})));
}

export async function disposeSession(conversationId: string): Promise<void> {
  const entry = sessions.get(conversationId);
  if (!entry) return;
  sessions.delete(conversationId);
  await entry.session.toolset.close();
}

/** Create a throwaway session (used by scheduled automations). */
export async function createEphemeralSession(): Promise<AgentSession> {
  const toolset = await loadEmailTools();
  return { agent: await buildAgent(toolset), toolset };
}

// Re-exported so existing callers (scheduler.ts, routes/chat.ts) keep working.
export { runPrompt, type RunHandlers } from "./run.js";
