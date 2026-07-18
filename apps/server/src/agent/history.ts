import type { Message } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { resolveActiveModel } from "../llm/registry.js";
import { parseStoredCards } from "./cards.js";
import { decoratePrompt, parseStoredRefs } from "./emailRefs.js";

/**
 * Rebuild a conversation's prior turns from the message log, so continuing an
 * older conversation (after a restart or session reset) keeps the agent's
 * memory. The model history is intentionally reconstructed as text; persisted
 * tool activity is presentation metadata for the chat UI.
 */
export async function loadHistory(conversationId: string): Promise<Message[]> {
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
      // The persisted row keeps `content` raw, but the model saw it with its
      // attached-email notes appended (turnRecorder.ts), so a rebuilt session
      // must see the same thing. The turn-time and focus notes are not
      // reconstructed: they described the moment the turn ran, and the next
      // live turn carries fresh ones.
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
