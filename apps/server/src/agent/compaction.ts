import { Agent, estimateTokens, serializeConversation, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { modelRegistry, resolveActiveModel } from "../llm/registry.js";
import { moduleLogger } from "../logger.js";
import { runPrompt } from "./run.js";

const defaultLog = moduleLogger("compaction");

/**
 * Keeps a long-running chat session inside its model's context window. pi's
 * Agent has no built-in compaction — a conversation left to grow forever
 * eventually overflows the provider's context and the turn fails outright.
 * runPrompt calls maybeCompact before every agent.prompt(...) so the
 * transcript is trimmed in advance instead of after the fact.
 */

/** Fraction of the model's context window that triggers compaction. */
const COMPACT_TRIGGER_FRACTION = 0.8;

/** Approximate recent-context tokens kept verbatim after compaction. Exported for testing findCutIndex. */
export const KEEP_RECENT_TOKENS = 20_000;

/** Prefixes shorter than this aren't worth the summarizer round trip. */
const MIN_PREFIX_MESSAGES = 4;

/** Cap on the serialized prefix handed to the summarizer model. */
const MAX_SERIALIZED_CHARS = 120_000;

/** Prepended to the serialized prefix when it was truncated to fit the cap. */
const DROPPED_NOTE =
  "[Note: earlier content in this range was dropped to fit the summarizer's input limit.]";

/** Marks the replacement message so a rendered transcript reads as a summary, not a real turn. */
const SUMMARY_PREFIX =
  "[Summary of the earlier conversation — older turns were compacted to fit the context window:]";

const SYSTEM_PROMPT = `You are compacting the earlier part of an email-assistant conversation so a
later turn can continue without the full transcript. Produce a dense factual brief that preserves
everything a follow-up turn might need: who and what was discussed, decisions and preferences the
user stated, open tasks, and every concrete identifier mentioned — email addresses, draft ids,
thread ids, message ids, document titles, dates.

Output ONLY the brief: no meta-commentary, no markdown decoration, no restating these instructions.`;

export interface CompactionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** chars/4 estimate for the system prompt plus the sum of pi's per-message estimate. */
function estimateStateTokens(systemPrompt: string, messages: AgentMessage[]): number {
  let total = Math.ceil(systemPrompt.length / 4);
  for (const message of messages) total += estimateTokens(message);
  return total;
}

/**
 * Index of the first message to keep. Walks backward accumulating estimated
 * tokens until KEEP_RECENT_TOKENS is reached, then nudges the index back over
 * any toolResult messages so the kept slice never opens mid-tool-call-pair (a
 * toolResult whose originating assistant tool_use was left in the compacted
 * prefix — most providers reject that shape outright). Deliberately not
 * "walk back to the nearest user message": one tool-heavy turn (a single user
 * message followed by a long assistant/toolResult run, e.g. a many-thread
 * digest) has no user message anywhere near the token cut point, and walking
 * back that far collapses the cut to ~0 — nothing compacted, so the next
 * prompt overflows again. Stepping back only over toolResult messages is
 * bounded by one tool-call batch, so the cut point stays close to the
 * token-based index and always makes progress; message 0 is never a
 * toolResult (it always has a preceding assistant tool_use), so the loop is
 * guaranteed to terminate. Returns 0 (nothing to compact) when the whole
 * transcript fits within KEEP_RECENT_TOKENS.
 *
 * Exported for direct unit testing — this walk is pure and LLM-free, unlike
 * the rest of maybeCompact.
 */
export function findCutIndex(messages: AgentMessage[]): number {
  let tokens = 0;
  let index = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (tokens >= KEEP_RECENT_TOKENS) break;
    const message = messages[i];
    if (!message) break;
    tokens += estimateTokens(message);
    index = i;
  }
  while (index > 0 && messages[index]?.role === "toolResult") index--;
  return index;
}

/**
 * pi's own harness augments AgentMessage with a "custom" role (branch/compaction
 * summaries, ad-hoc notes) that this app never produces, but the type union still
 * carries it. serializeConversation only understands the base user/assistant/
 * toolResult union, so filter defensively rather than assume the narrower type.
 */
function isCoreMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/**
 * One-shot, tool-less summary of the messages about to be dropped from
 * context (humanizer.ts pattern). Returns "" on an empty model result; throws
 * on any other failure, which maybeCompact treats as fail-open.
 */
async function summarizePrefix(prefix: AgentMessage[]): Promise<string> {
  let serialized = serializeConversation(prefix.filter(isCoreMessage));
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    serialized = `${DROPPED_NOTE}\n\n${serialized.slice(serialized.length - MAX_SERIALIZED_CHARS)}`;
  }

  const model = await resolveActiveModel();
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: [] },
    streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
  });
  const raw = await runPrompt({ agent }, serialized);
  return raw.trim();
}

/** Compacts agent.state.messages in place when the estimated context nears the model's window. Returns true when a compaction happened. Never throws (fail-open: on any error the messages are left untouched and false is returned). */
export async function maybeCompact(agent: Agent, log: CompactionLogger = defaultLog): Promise<boolean> {
  try {
    const { systemPrompt, model, messages } = agent.state;
    const estimatedTokens = estimateStateTokens(systemPrompt, messages);
    if (estimatedTokens <= COMPACT_TRIGGER_FRACTION * model.contextWindow) return false;

    const cutIndex = findCutIndex(messages);
    const prefix = messages.slice(0, cutIndex);
    if (prefix.length < MIN_PREFIX_MESSAGES) return false;
    const kept = messages.slice(cutIndex);

    const summary = await summarizePrefix(prefix);
    if (!summary) {
      log.warn({ prefixMessages: prefix.length }, "compaction summary was empty, leaving messages untouched");
      return false;
    }

    const summaryMessage: AgentMessage = {
      role: "user",
      content: `${SUMMARY_PREFIX}\n\n${summary}`,
      timestamp: kept[0]?.timestamp ?? Date.now(),
    };

    const beforeMessages = messages.length;
    const newMessages = [summaryMessage, ...kept];
    agent.state.messages = newMessages;
    log.info(
      { beforeMessages, afterMessages: newMessages.length, estimatedTokens },
      "compacted conversation history",
    );
    return true;
  } catch (error) {
    log.warn({ err: error }, "compaction failed, leaving messages untouched");
    return false;
  }
}
