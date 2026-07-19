import {
  type AgentMessage,
  estimateTokens,
  serializeConversation,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { moduleLogger, type TurnLogger } from "../core/logger.js";
import { runOneShot } from "./oneShot.js";
import { prompts } from "./prompts.js";

const defaultLog = moduleLogger("compaction");

/**
 * Keeps a long-running chat session inside its model's context window: pi's
 * Agent has no built-in compaction, so a conversation left to grow overflows
 * the provider's context and the turn fails outright.
 */

const COMPACT_TRIGGER_FRACTION = 0.8;

export const KEEP_RECENT_TOKENS = 20_000;

/** Prefixes shorter than this aren't worth the summarizer round trip. */
const MIN_PREFIX_MESSAGES = 4;

const MAX_SERIALIZED_CHARS = 120_000;

const DROPPED_NOTE =
  "[Note: earlier content in this range was dropped to fit the summarizer's input limit.]";

const SUMMARY_PREFIX =
  "[Summary of the earlier conversation — older turns were compacted to fit the context window:]";

function estimateStateTokens(systemPrompt: string, messages: AgentMessage[]): number {
  let total = Math.ceil(systemPrompt.length / 4);
  for (const message of messages) total += estimateTokens(message);
  return total;
}

/**
 * Index of the first message to keep. Walks backward accumulating estimated
 * tokens until KEEP_RECENT_TOKENS, then steps back over any toolResult
 * messages so the kept slice never opens on a toolResult whose originating
 * assistant tool_use was left in the compacted prefix (most providers reject
 * that shape). Not "walk back to the nearest user message": one tool-heavy
 * turn has no user message near the token cut, so that collapses the cut to
 * ~0 and nothing compacts. Stepping back only over toolResults is bounded by
 * one tool-call batch, so the cut stays near the token index and always makes
 * progress; message 0 is never a toolResult, so the loop terminates. Returns
 * 0 when the whole transcript fits within KEEP_RECENT_TOKENS.
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
 * pi's AgentMessage union carries a "custom" role (branch/compaction
 * summaries) this app never produces; serializeConversation only understands
 * the base user/assistant/toolResult union, so filter defensively.
 */
function isCoreMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/**
 * One-shot, tool-less summary of the messages about to be dropped. Returns ""
 * on an empty model result; throws otherwise, which compactedMessages treats
 * as fail-open.
 */
async function summarizePrefix(prefix: AgentMessage[], signal?: AbortSignal): Promise<string> {
  let serialized = serializeConversation(prefix.filter(isCoreMessage));
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    serialized = `${DROPPED_NOTE}\n\n${serialized.slice(serialized.length - MAX_SERIALIZED_CHARS)}`;
  }

  const raw = await runOneShot({ systemPrompt: prompts.compaction, prompt: serialized, signal });
  return raw.trim();
}

export interface CompactOptions {
  /**
   * Compact even under the trigger fraction, for recovery after a provider
   * context-overflow error: the provider has proven the estimate wrong, so the
   * transcript actually shrinks before a retry can succeed.
   */
  force?: boolean;
  signal?: AbortSignal;
}

export interface CompactionState {
  systemPrompt: string;
  model: { contextWindow: number };
  messages: AgentMessage[];
}

/**
 * Compacted replacement for a transcript nearing the model's context window:
 * older turns summarized into one brief, the recent ~KEEP_RECENT_TOKENS kept
 * verbatim. Returns null when nothing needs (or can) be compacted. Never
 * throws: fail-open, any error yields null and the caller keeps its messages.
 */
export async function compactedMessages(
  state: CompactionState,
  log: TurnLogger = defaultLog,
  options: CompactOptions = {},
): Promise<AgentMessage[] | null> {
  try {
    const { systemPrompt, model, messages } = state;
    const estimatedTokens = estimateStateTokens(systemPrompt, messages);
    if (!options.force && estimatedTokens <= COMPACT_TRIGGER_FRACTION * model.contextWindow) {
      return null;
    }

    const cutIndex = findCutIndex(messages);
    const prefix = messages.slice(0, cutIndex);
    if (prefix.length < MIN_PREFIX_MESSAGES) return null;
    const kept = messages.slice(cutIndex);

    const summary = await summarizePrefix(prefix, options.signal);
    if (!summary) {
      log.warn(
        { prefixMessages: prefix.length },
        "compaction summary was empty, leaving messages untouched",
      );
      return null;
    }

    const summaryMessage: AgentMessage = {
      role: "user",
      content: `${SUMMARY_PREFIX}\n\n${summary}`,
      timestamp: kept[0]?.timestamp ?? Date.now(),
    };

    const newMessages = [summaryMessage, ...kept];
    log.info(
      { beforeMessages: messages.length, afterMessages: newMessages.length, estimatedTokens },
      "compacted conversation history",
    );
    return newMessages;
  } catch (error) {
    log.warn({ err: error }, "compaction failed, leaving messages untouched");
    return null;
  }
}
