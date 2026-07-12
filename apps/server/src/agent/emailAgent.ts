import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { LANGUAGE_ENGLISH_NAMES, type Language } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getLanguageSetting, getTimezoneSetting, getWriteAccessAccounts } from "../db/settings.js";
import { resolveActiveModel } from "../llm/registry.js";
import { type EmailToolset, loadEmailTools } from "../pipedream/mcp.js";
import { buildAccountsContext } from "./accounts.js";
import { composeBriefingTool } from "./briefingTool.js";
import { parseStoredCards } from "./cards.js";
import { presentChoicesTool } from "./choicesTool.js";
import { AI_WRITING_TELLS, buildVoiceContext } from "./composition.js";
import { delegateTool } from "./delegate.js";
import { decoratePrompt, parseStoredRefs } from "./emailRefs.js";
import { buildKnowledgeContext, buildKnowledgeTools } from "./knowledgeTools.js";
import { buildMailReadTools } from "./mailTools.js";
import { streamViaModelRegistry } from "./oneShot.js";
import { type RunHandlers, runPrompt, type TurnLogger } from "./run.js";
import { voiceLearnTool } from "./voiceLearn.js";
import { listWaitingThreadsTool } from "./waitingTools.js";

const SYSTEM_PROMPT = `You are Trailin, a personal email assistant working over the user's
connected accounts — email and possibly other apps.

Guidelines:
- READING mail: search_mail, list_threads, read_thread and list_sent_messages serve from a local
  index of every connected account's mail (roughly the last month, refreshed every few minutes —
  pass refresh: true only when the user asks about mail that may have just arrived). They cover
  all accounts in one call, or one account via their account parameter. list_drafts shows the
  unsent drafts sitting in each account's Drafts folder.
- ACTING on mail (drafts, sending, labels) goes through per-account tools. Each one's description
  says which account it acts as ("Acts as the connected account: …"); with more than one account
  of the same app, tool names carry an account suffix (e.g. gmail-create-draft__work). The
  connected accounts and what each is for are listed at the end of this prompt. Pick the account
  and email the user means. When more than one account, thread or draft plausibly matches a
  request to draft, send, label or delete — and the user's message (or an attached email
  reference) doesn't settle it — never pick one silently: call present_choices with the
  candidates, end the turn with a short question, and act only on the user's pick.
- If you have no email tools, tell the user to finish the email setup under Settings → Connect email.
- Prefer reading and summarizing over acting. Look things up before you claim them.
- Never send, reply to, forward or delete an email unless the user's request explicitly asks for it.
- Tools that find or produce something for the user render it as a card right in the conversation:
  search hits, full threads, created and updated drafts, briefings, choice buttons. The card IS
  the display — never restate in prose what its card already shows (quoting a draft's subject or
  body, re-listing hits, re-printing thread messages). Add only what the card doesn't say: your
  answer, your read on it, or the next step, in a line or two.
- Keep answers short and skimmable, and let plain prose carry most of it. Your replies render as
  Markdown, so use it — but only where it genuinely helps the reader: **bold** for the few words
  that matter, bullet or numbered lists for sets of items (inbox summaries: **sender**: subject,
  one-line gist), \`code\` for exact values like email addresses or filenames, and tables only for
  data that is truly tabular. For a short or single-idea answer, a sentence or two beats a decorated
  one — skip headings, bold and bullets. Never wrap a whole reply in a list or bold half the words.
- Write like a person, not a chatbot. This matters most in email drafts and summaries. Lead with
  the point and vary sentence length. Normal greetings and sign-offs ("Hi Sarah," / "Best,") are
  fine, but avoid these AI tells:
${AI_WRITING_TELLS}
- In summaries, say what's actually in the source and attribute it concretely (not "experts say" or
  "studies show"); when something isn't known, say so instead of inventing plausible filler. Match the
  user's own voice in email drafts and keep summaries neutral, and don't add opinions or personality that
  aren't theirs.
- When you compose a digest or summary that pulls several items together, don't ship your first
  pass. Reread it once as if you were hunting for the AI tells above, fix what you find, then give
  only the finished version. Do this silently in the same turn: the reader sees the final digest,
  never the rough pass or notes about it. Skip it for short conversational replies — and for email
  drafts, whose bodies get a mechanical humanizer edit at save time anyway.
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
- Ground every email draft in real context: before drafting a reply, read the full thread with
  read_thread (not just the newest message), and pull anything relevant from memory or the library
  (who the correspondent is, prior agreements, standing facts) so the draft is specific and
  consistent with what was already said. Pass the thread's threadId (from search_mail, read_thread
  or list_waiting_threads) to the create-draft tool so the draft lands on the conversation.
- User messages may end with [Attached email: …] notes — emails the user explicitly pinned in
  the composer. They are authoritative: act on exactly that thread and account (read_thread the
  given threadId before drafting a reply, and pass it to the create-draft tool); never substitute
  a different thread found by searching.
- For work that spans many independent lookups (a digest over many threads, several senders'
  histories, cross-checking documents), fan the lookups out with the delegate tool and synthesize
  the workers' reports instead of doing every lookup serially yourself.
- When the user asks about a person ("find everything from X", "my history with X"), search_mail
  already covers every connected account in one call — query both the name and any address you
  know for them. The hit cards already list every match — reply with the shape of the history
  (who wants what, roughly when) and which threads look worth opening, not a re-listing.
- When asked to summarize an email thread or chain, read the whole thread with read_thread first
  (never just the latest message), then summarize it chronologically: who wants what, what was
  agreed or decided, what changed along the way, what is still open, and what (if anything) is
  waiting on the user.
- Past scheduled-automation runs (morning briefings, end-of-day learnings) are on record: use
  automation_history to find runs and automation_run_read for a run's full text whenever the user
  references "your briefing", something "you flagged", or what an automation found on some day.
- list_waiting_threads shows, per connected account with waiting-thread tracking, threads where the
  user sent the last message and nobody has replied for a day or more. Use it when the user asks
  what they're waiting on, for follow-up checks, and in briefings; for long-overdue threads, offer
  a nudge draft.
- compose_briefing renders a structured, interactive briefing card (grouped by how urgently each
  message needs the user, with per-thread actions). Use it whenever you produce a multi-message
  inbox digest, and give every item its real threadId so the card's actions work. Keep every
  item to one line — a fact and an action, never an explanation sentence: "contract: signs Fri,
  wants payment terms fixed → reply", not "Anna replied regarding the contract, mentioning that
  she plans to sign on Friday but wants the payment terms adjusted first." Newsletters, receipts
  and other low-value mail are never items, only a rolled-up count. When you call it, the card IS
  the report: close with exactly one line, never a re-listing of the items.
- To work with an email attachment (a PDF someone sent, a document to summarize), save it into the
  document library with that account's save-attachment tool (passing the messageId from
  search_mail or read_thread results), then find it with library_search and read it with
  library_read once indexed.
- Draft bodies go through a humanizer edit before they are saved; the draft card always shows the
  saved text. When the create-draft result reports a final text different from what you submitted,
  that saved version is the draft — whenever you mention its wording, describe that text, never
  your pre-pass.`;

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

export interface BuildSystemPromptOptions {
  /** False for unattended scheduled runs: see the branch below — must match the toolset's providerWrites. */
  interactive: boolean;
}

/** The base prompt plus the Settings rules (scheduled runs rely on them too). */
export async function buildSystemPrompt(
  options: BuildSystemPromptOptions = { interactive: true },
): Promise<string> {
  let prompt = SYSTEM_PROMPT;

  if (!options.interactive) {
    // Scheduled automations run with no human to review a send before it goes
    // out, so loadEmailTools withholds every provider write tool for this run
    // regardless of any account's write-access setting (see providerWrites in
    // pipedream/mcp.ts) — say so plainly rather than let the interactive
    // write-access copy below imply sending is possible here.
    prompt += `
- Unattended scheduled run: provider write actions (send, reply, forward, label, move, delete) are
  unavailable in this run, regardless of any account's write-access setting in Settings →
  Permissions. Where a task would otherwise call for one of those, create a draft instead so the
  user can review and send it themselves.`;
  } else {
    const writeAccessIds = await getWriteAccessAccounts();
    if (writeAccessIds.length === 0) {
      prompt += `
- Read-only mode: you only have tools that read, search or create drafts. You cannot send, delete
  or change anything. If the user asks for such an action, explain that write access is granted
  per account under Settings → Permissions.`;
    } else {
      prompt += `
- Write access is granted per account, not globally — see which connected accounts are armed in
  the list below. On a read-only account you can only read, search and create drafts; if the user
  asks for more there, explain that write access is granted per account under Settings →
  Permissions.`;
    }
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

  prompt += await buildAccountsContext();
  prompt += await buildVoiceContext();
  prompt += await buildKnowledgeContext();
  return prompt;
}

export interface AgentSession {
  agent: Agent;
  toolset: EmailToolset;
  /**
   * Turns currently running against this session. sweepSessions (below) must
   * never close a session's toolset while this is above zero — go through
   * runTurn (not the bare runPrompt) so a turn can't forget to mark itself.
   */
  inFlight: number;
  /** Idle/LRU eviction clock: refreshed on creation, on lookup, and when a turn ends. */
  lastUsed: number;
  /**
   * Runs one prompt through this session, exactly like the standalone
   * runPrompt, but also marks the session busy for the turn's duration and
   * refreshes lastUsed when it ends — see sweepSessions.
   */
  runTurn(
    prompt: string,
    handlers?: RunHandlers,
    signal?: AbortSignal,
    log?: TurnLogger,
  ): Promise<string>;
}

/** Wraps a fresh agent/toolset pair with the busy-tracking runTurn every cached session shares. */
function createAgentSession(agent: Agent, toolset: EmailToolset): AgentSession {
  const session: AgentSession = {
    agent,
    toolset,
    inFlight: 0,
    lastUsed: Date.now(),
    async runTurn(prompt, handlers, signal, log) {
      session.inFlight++;
      try {
        return await runPrompt(session, prompt, handlers, signal, log);
      } finally {
        session.inFlight--;
        session.lastUsed = Date.now();
      }
    },
  };
  return session;
}

// Idle sessions keep their MCP connections open for nothing; cap both how
// long one can sit unused and how many can exist at once.
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX_COUNT = 20;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, AgentSession>();
// In-flight session creations, keyed by conversationId — lets two concurrent
// requests for a brand-new conversation share one creation instead of each
// opening (and one of them leaking) its own MCP session.
const pendingSessions = new Map<string, Promise<AgentSession>>();

/** Same disposal path resetSessions()/disposeSession() use, for idle/LRU eviction too. */
function evictSession(conversationId: string, session: AgentSession): void {
  sessions.delete(conversationId);
  void session.toolset.close().catch(() => {});
}

function sweepSessions(): void {
  const now = Date.now();
  for (const [conversationId, session] of sessions) {
    // A turn is running against this session; closing its toolset now would
    // pull the rug out from under an in-flight tool call.
    if (session.inFlight > 0) continue;
    if (now - session.lastUsed > SESSION_IDLE_TTL_MS) evictSession(conversationId, session);
  }
  if (sessions.size > SESSION_MAX_COUNT) {
    const evictable = [...sessions.entries()]
      .filter(([, session]) => session.inFlight === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [conversationId, session] of evictable.slice(0, sessions.size - SESSION_MAX_COUNT)) {
      evictSession(conversationId, session);
    }
  }
}

const sweepTimer = setInterval(sweepSessions, SESSION_SWEEP_INTERVAL_MS);
sweepTimer.unref();

/** Fixed at a balanced default, not user-configurable — "medium" wherever the model can reason at all. */
function resolveThinkingLevel(model: { reasoning: boolean }): "off" | "low" | "medium" | "high" {
  return model.reasoning ? "medium" : "off";
}

interface BuildAgentOptions {
  /** False for automation runs: nobody is present to click a choices card, so present_choices is withheld. */
  interactive: boolean;
}

async function buildAgent(
  toolset: EmailToolset,
  history: Message[] = [],
  options: BuildAgentOptions = { interactive: true },
): Promise<Agent> {
  // Active model comes from Settings (SQLite), falling back to .env.
  const model = await resolveActiveModel();
  return new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt({ interactive: options.interactive }),
      model,
      thinkingLevel: resolveThinkingLevel(model),
      // Mirror-served mail read tools, per-account write tools (drafts,
      // attachments, MCP writes), the local memory/library tools, the
      // delegate fan-out tool for spreading independent lookups across
      // parallel background workers, and (interactive sessions only)
      // present_choices for disambiguating with the user instead of guessing.
      tools: [
        ...buildMailReadTools({ visibleCards: true }),
        ...toolset.tools,
        ...buildKnowledgeTools(),
        delegateTool,
        voiceLearnTool,
        listWaitingThreadsTool,
        composeBriefingTool,
        ...(options.interactive ? [presentChoicesTool] : []),
      ],
      messages: history,
    },
    // Route model calls through the registry so stored credentials apply
    // (subscription OAuth with auto-refresh, saved API keys, then env vars).
    streamFn: streamViaModelRegistry,
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
      // Mirror of turnRecorder.ts's live prompt: the persisted row keeps
      // `content` raw, but the model saw it with its attached-email notes
      // appended, so a rebuilt session must see the same thing.
      content = decoratePrompt(content, parseStoredRefs(row.refs));
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
    existing.agent.state.systemPrompt = await buildSystemPrompt();
    existing.agent.state.thinkingLevel = resolveThinkingLevel(existing.agent.state.model);
    return existing;
  }

  // Two concurrent requests for the same new conversationId must share one
  // creation — otherwise both pass the check above and each opens its own
  // MCP session, leaking whichever one loses the race to `sessions.set`.
  const inFlight = pendingSessions.get(conversationId);
  if (inFlight) return inFlight;

  const creation = (async (): Promise<AgentSession> => {
    const toolsetPromise = loadEmailTools();
    try {
      const [toolset, history] = await Promise.all([toolsetPromise, loadHistory(conversationId)]);
      const session = createAgentSession(
        await buildAgent(toolset, history, { interactive: true }),
        toolset,
      );
      sessions.set(conversationId, session);
      if (sessions.size > SESSION_MAX_COUNT) sweepSessions();
      return session;
    } catch (error) {
      // toolsetPromise may have resolved (live MCP connections open) even
      // though loadHistory or buildAgent failed — close it instead of
      // leaking those connections on every retry of a failing conversation.
      await toolsetPromise.then((t) => t.close()).catch(() => {});
      throw error;
    }
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
  await Promise.all(all.map((session) => session.toolset.close().catch(() => {})));
}

export async function disposeSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId);
  if (!session) return;
  sessions.delete(conversationId);
  await session.toolset.close();
}

/**
 * Create a throwaway session (used by scheduled automations). No human
 * reviews a scheduled run's actions before they happen, so it must not be
 * able to send/reply/forward/delete mail even on accounts with write access
 * armed in Settings — providerWrites: false withholds every provider write
 * tool while leaving draft tools untouched (see loadEmailTools).
 */
export async function createEphemeralSession(): Promise<AgentSession> {
  const toolset = await loadEmailTools({ providerWrites: false });
  try {
    return createAgentSession(await buildAgent(toolset, [], { interactive: false }), toolset);
  } catch (error) {
    // buildAgent failing (bad model config, a settings read failing) must not
    // leak the MCP connections loadEmailTools already opened — this runs on
    // every scheduled automation tick.
    await toolset.close().catch(() => {});
    throw error;
  }
}

// Re-exported for automations/scheduler.ts.
export { type RunHandlers, runPrompt };
