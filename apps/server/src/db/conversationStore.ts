import { emitServerEvent } from "../core/events.js";
import { db, lazyTransaction, schema, sqlite } from "./index.js";

/**
 * Create/delete lifecycle for the Conversation row (a chat, id = a uuid, or an
 * automation run mirror, id = the run id) and the "conversations" emits that go
 * with it. Other conversation-table access stays where it is.
 */

export interface EnsureConversationInput {
  type: "chat" | "automation";
  title: string;
}

/**
 * Idempotently create the parent Conversation row (onConflictDoNothing makes
 * repeat calls no-ops). Returns true only when this call created the row, which
 * is also the only case that emits "conversations".
 */
export async function ensureConversation(
  id: string,
  input: EnsureConversationInput,
): Promise<boolean> {
  const result = await db
    .insert(schema.conversations)
    .values({ id, title: input.title, type: input.type, createdAt: new Date().toISOString() })
    .onConflictDoNothing({ target: schema.conversations.id });
  const created = result.changes > 0;
  if (created) emitServerEvent("conversations");
  return created;
}

// Deletes a conversation and its messages in one transaction, so a crash
// between the two deletes can't leave one without the other. agent_drafts rows
// are left alone deliberately: a snapshot's conversationId is a navigation
// link, not an ownership edge, and a dangling link degrades to "no link" at
// read time.
const deleteConversationRows = lazyTransaction((id: string) => {
  sqlite.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(id);
});

export function deleteConversationCascade(id: string): void {
  deleteConversationRows(id);
  emitServerEvent("conversations");
}
