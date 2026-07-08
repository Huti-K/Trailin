import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { LANGUAGE_ENGLISH_NAMES } from "@trailin/shared";
import { db, schema } from "../db/index.js";
import { listMemories } from "../db/memories.js";
import { getEmailWriteSetting, getLanguageSetting } from "../db/settings.js";
import { listDocuments } from "../library/store.js";
import { modelRegistry, resolveActiveModel } from "../llm/registry.js";
import { loadEmailTools, type EmailToolset } from "../pipedream/mcp.js";
import { buildKnowledgeTools } from "./knowledgeTools.js";

/** Library titles listed in the system prompt are capped so it can't grow unbounded. */
const LIBRARY_TOC_LIMIT = 100;

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
  that matter, bullet or numbered lists for sets of items (inbox summaries: sender — subject —
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
- Timestamps from tools are usually UTC; present them in a human-friendly way.
- You have a long-term memory: saved entries are listed at the end of this prompt. When the
  user asks you to remember something, or states a lasting fact or preference, save it with
  memory_save. Don't save one-off task details or things already in memory. When a saved fact
  changes, update the existing entry with memory_update (using the id shown in brackets)
  instead of saving a second, contradicting entry. Use memory_delete only when the user asks
  you to forget something. Memory is for short standing facts only — longer-form knowledge
  (background on a correspondent, a thread summary, research findings) belongs in the library
  as a note instead: save it with library_write.
- The user keeps a local document library (PDFs, notes) for you — titles are listed at the end
  of this prompt. Check it with library_search whenever a question or task could plausibly be
  covered by one of those documents, not only when the user says "my documents"; read the full
  match with library_read and say which document you used. On scheduled automation runs, search
  the library first if the task relates to any listed document.`;

/** The base prompt plus the Settings rules (scheduled runs rely on them too). */
async function buildSystemPrompt(): Promise<string> {
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

  const memories = await listMemories();
  if (memories.length > 0) {
    prompt += `\n\nLong-term memory (saved earlier; the user manages these on the Knowledge page):\n${memories
      .map((m) => `- [${m.id.slice(0, 8)}] ${m.content}`)
      .join("\n")}`;
  }

  const indexed = (await listDocuments()).filter(
    (d) => d.status === "indexed" && d.chunkCount > 0,
  );
  if (indexed.length > 0) {
    const shown = indexed.slice(0, LIBRARY_TOC_LIMIT);
    const lines = shown.map((d) => `- ${d.title} (${d.ext})`);
    if (indexed.length > shown.length) {
      lines.push(`… and ${indexed.length - shown.length} more — use library_list.`);
    }
    prompt += `\n\nDocument library (search with library_search, read with library_read):\n${lines.join("\n")}`;
  }
  return prompt;
}

export interface AgentSession {
  agent: Agent;
  toolset: EmailToolset;
}

const sessions = new Map<string, AgentSession>();

async function buildAgent(toolset: EmailToolset, history: Message[] = []): Promise<Agent> {
  return new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(),
      // Active model comes from Settings (SQLite), falling back to .env.
      model: await resolveActiveModel(),
      // Email tools from Pipedream plus the local memory/library tools.
      tools: [...toolset.tools, ...buildKnowledgeTools()],
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
 * memory. Tool calls aren't persisted — the seeded context is text-only.
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
    const content = row.content.trim();
    if (!content) continue;
    const timestamp = Date.parse(row.createdAt) || Date.now();
    if (row.role === "user") {
      messages.push({ role: "user", content, timestamp });
    } else {
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
  if (existing) return existing;

  const [toolset, history] = await Promise.all([loadEmailTools(), loadHistory(conversationId)]);
  const session: AgentSession = { agent: await buildAgent(toolset, history), toolset };
  sessions.set(conversationId, session);
  return session;
}

/** Drop all in-memory agent sessions (e.g. after auth or model changes). */
export async function resetSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.toolset.close().catch(() => {})));
}

export async function disposeSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId);
  if (!session) return;
  sessions.delete(conversationId);
  await session.toolset.close();
}

/** Create a throwaway session (used by scheduled automations). */
export async function createEphemeralSession(): Promise<AgentSession> {
  const toolset = await loadEmailTools();
  return { agent: await buildAgent(toolset), toolset };
}

export interface RunHandlers {
  onTextDelta?: (delta: string) => void;
  onThinking?: () => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string, isError: boolean) => void;
}

/**
 * Run one prompt through the agent, forwarding streaming events to the
 * handlers. Resolves with the assistant's final text for this turn.
 */
export async function runPrompt(
  session: AgentSession,
  prompt: string,
  handlers: RunHandlers = {},
): Promise<string> {
  let text = "";

  const unsubscribe = session.agent.subscribe((event) => {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "message_update": {
        const inner = e.assistantMessageEvent as
          | { type?: string; delta?: unknown }
          | undefined;
        if (inner && typeof inner.delta === "string") {
          // Forward only visible text; thinking deltas keep their own type.
          if (!inner.type || String(inner.type).startsWith("text")) {
            text += inner.delta;
            handlers.onTextDelta?.(inner.delta);
          } else if (String(inner.type).startsWith("thinking")) {
            handlers.onThinking?.();
          }
        }
        break;
      }
      case "tool_execution_start": {
        const name = (e.toolName ?? e.name ?? "tool") as string;
        handlers.onToolStart?.(name);
        break;
      }
      case "tool_execution_end": {
        const name = (e.toolName ?? e.name ?? "tool") as string;
        handlers.onToolEnd?.(name, Boolean(e.isError));
        break;
      }
    }
  });

  try {
    await session.agent.prompt(prompt);
  } finally {
    if (typeof unsubscribe === "function") unsubscribe();
  }

  // pi doesn't throw on provider failures (missing credentials, refused
  // requests); it records them on the state. Surface them to the caller.
  const failure = session.agent.state.errorMessage;
  if (failure) throw new Error(failure);

  return text.trim();
}
