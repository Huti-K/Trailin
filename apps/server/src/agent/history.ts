import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ChatToolCall } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { resolveActiveModel } from "../llm/registry.js";
import { decoratePrompt, parseStoredRefs } from "./emailRefs.js";

/**
 * The durable model transcript. A turn's rows carry everything the model saw:
 * the user prompt (decorated at load, same as when it ran), the assistant
 * text, and the turn's tool calls with their results (messages.tool_calls —
 * one column serving both the UI's activity view and this rebuild). When a
 * live session compacts, recordCompactionMarker persists the summary as a
 * role='compaction' row so a rebuilt session starts from the same compacted
 * shape rather than the full raw history.
 */

type MessageRow = typeof schema.messages.$inferSelect;

/** Trusted parse of the messages.tool_calls column (own-db JSON). */
export function parseStoredToolCalls(value: string | null): ChatToolCall[] | undefined {
  return value ? (JSON.parse(value) as ChatToolCall[]) : undefined;
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Text of a persisted tool result. Results were captured from pi's untyped
 * tool-result events, so the shape is checked rather than assumed.
 */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * One assistant row back into model messages: an assistant message carrying
 * the turn's tool calls, each call's toolResult, then the reply text. A
 * multi-batch turn flattens into one call batch — every result still follows
 * an assistant message containing its call, which is the shape providers
 * require.
 */
function expandAssistantRow(row: MessageRow, model: Model<Api>, timestamp: number): Message[] {
  const text = row.content.trim();
  const toolCalls = parseStoredToolCalls(row.toolCalls) ?? [];
  const modelFields = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    timestamp,
  } as const;

  const messages: Message[] = [];
  if (toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: toolCalls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: (call.parameters ?? {}) as Record<string, unknown>,
      })),
      stopReason: "toolUse",
      ...modelFields,
    });
    for (const call of toolCalls) {
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: resultText(call.result) }],
        isError: call.isError,
        timestamp,
      });
    }
  }
  if (text) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      ...modelFields,
    });
  }
  return messages;
}

/**
 * Rebuild a conversation's model history from the message log, so continuing
 * an older conversation (after a restart or session reset) keeps the agent's
 * memory. A compaction row replays exactly as the live session experienced
 * it: everything before the summary is dropped except the rows from its
 * kept-verbatim tail (compaction_cutoff), which stay in full.
 */
export async function loadHistory(conversationId: string): Promise<Message[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(schema.messages.createdAt);
  if (rows.length === 0) return [];

  const model = await resolveActiveModel();

  // Row-level accumulation, so a compaction row can drop the rows its summary
  // covers while keeping the tail rows (ms >= cutoff) verbatim. A cut that
  // lands inside one row's expansion keeps the whole row — slightly more
  // context than the live session held, trimmed again by the next compaction.
  const expanded: { ms: number; messages: Message[] }[] = [];
  for (const row of rows) {
    const ms = Date.parse(row.createdAt) || Date.now();
    if (row.role === "compaction") {
      const cutoff = row.compactionCutoff ?? ms;
      const kept = expanded.filter((entry) => entry.ms >= cutoff);
      expanded.length = 0;
      expanded.push(
        { ms, messages: [{ role: "user", content: row.content, timestamp: ms }] },
        ...kept,
      );
      continue;
    }
    const content = row.content.trim();
    if (row.role === "user") {
      if (!content) continue;
      // The persisted row keeps `content` raw, but the model saw it with its
      // attached-email notes appended (turnRecorder.ts), so a rebuilt session
      // must see the same thing. The turn-time and focus notes are not
      // reconstructed: they described the moment the turn ran, and the next
      // live turn carries fresh ones.
      expanded.push({
        ms,
        messages: [
          {
            role: "user",
            content: decoratePrompt(content, parseStoredRefs(row.refs)),
            timestamp: ms,
          },
        ],
      });
      continue;
    }
    const messages = expandAssistantRow(row, model, ms);
    if (messages.length > 0) expanded.push({ ms, messages });
  }
  return expanded.flatMap((entry) => entry.messages);
}

/**
 * Persist one compaction: the summary message that now stands in for the
 * session's older turns, plus the timestamp where its kept-verbatim tail
 * begins. Written by the session owner when a live compaction lands — the one
 * message row that is not part of a turn; the messages API excludes it.
 */
export async function recordCompactionMarker(
  conversationId: string,
  compacted: AgentMessage[],
): Promise<void> {
  const summary = compacted[0];
  const content = typeof summary?.content === "string" ? summary.content : "";
  if (!content) return;
  await db.insert(schema.messages).values({
    id: randomUUID(),
    conversationId,
    role: "compaction",
    content,
    compactionCutoff: compacted[1]?.timestamp ?? Date.now(),
    createdAt: new Date().toISOString(),
  });
}
