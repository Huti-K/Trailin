import type { AgentCard, EmailRef } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { emitServerEvent } from "../core/events.js";
import { db, schema } from "../db/index.js";

/**
 * Conversation focus: the account (and, while one email is the topic, the
 * thread) a chat works in. Focus is the agent's tool-call DEFAULT, not a hard
 * scope: the turn prompt carries it as a note and the agent may still go
 * cross-account when the user clearly asks. Last writer wins. Three writers
 * funnel through here: the chat header chip, the user's @-mention refs, and
 * the agent's own activity inferred from the cards it emits. Every write emits
 * "conversations" so the chip follows live.
 */

export interface FocusPatch {
  accountId: string;
  /** null clears the thread part (the topic moved on); undefined leaves it as is. */
  threadId?: string | null;
  subject?: string | null;
}

export async function applyConversationFocus(
  conversationId: string,
  patch: FocusPatch,
): Promise<void> {
  await db
    .update(schema.conversations)
    .set({
      focusAccountId: patch.accountId,
      ...(patch.threadId !== undefined
        ? {
            focusThreadId: patch.threadId,
            focusThreadSubject: patch.threadId === null ? null : (patch.subject ?? null),
          }
        : {}),
    })
    .where(eq(schema.conversations.id, conversationId));
  emitServerEvent("conversations");
}

export async function clearConversationFocus(conversationId: string): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ focusAccountId: null, focusThreadId: null, focusThreadSubject: null })
    .where(eq(schema.conversations.id, conversationId));
  emitServerEvent("conversations");
}

/** An @-mention pins a specific email; focus follows the last one attached. */
export function focusFromRefs(refs: EmailRef[] | undefined): FocusPatch | null {
  const last = refs?.[refs.length - 1];
  if (!last) return null;
  return { accountId: last.accountId, threadId: last.threadId, subject: last.subject ?? null };
}

export function focusFromCard(card: AgentCard): FocusPatch | null {
  switch (card.kind) {
    case "email_draft":
      return card.account
        ? {
            accountId: card.account.accountId,
            threadId: card.draft.threadId ?? null,
            subject: card.draft.subject ?? null,
          }
        : null;
    // An attachments listing is an aside, not a focus move. Choices and
    // briefing carry no top-level account (a briefing spans accounts, a choices
    // card is a question) and never move focus; a message draft is
    // channel-scoped, not email-account-scoped.
    case "attachments":
    case "choices":
    case "briefing":
    case "message_draft":
      return null;
    default:
      return card satisfies never;
  }
}

/**
 * The standing-focus note appended to each turn's prompt: what makes focus the
 * tool-call default. Empty string when the conversation has no focus.
 */
export async function conversationFocusNote(conversationId: string): Promise<string> {
  const [row] = await db
    .select({
      focusAccountId: schema.conversations.focusAccountId,
      focusThreadId: schema.conversations.focusThreadId,
      focusThreadSubject: schema.conversations.focusThreadSubject,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!row?.focusAccountId) return "";

  const thread = row.focusThreadId
    ? `, currently discussing thread "${row.focusThreadSubject ?? row.focusThreadId}" (id ${row.focusThreadId})`
    : "";
  return (
    `\n\n[Conversation focus: account ${row.focusAccountId}${thread}. Default your ` +
    `searches, reads, and drafts to this focus; go wider only when this message asks for it.]`
  );
}
