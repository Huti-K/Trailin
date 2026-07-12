import type { AgentCard, EmailRef } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { emitServerEvent } from "../events.js";

/**
 * Conversation focus: the account — and, while one email is the topic, the
 * thread — a chat works in. Focus is the agent's tool-call DEFAULT, not a
 * hard scope: the turn prompt carries it as a note (conversationFocusNote)
 * and the agent may still go cross-account when the user clearly asks.
 *
 * Last writer wins. Three writers funnel through here: a manual pick from the
 * chat header chip (routes/chat.ts PATCH), the user's @-mention refs, and the
 * agent's own activity observed through the cards it emits — inference over
 * cards rather than a dedicated tool, so keeping the chip honest can't be
 * forgotten by the model. Every write emits "conversations" so the chip
 * follows live.
 */

export interface FocusPatch {
  accountId: string;
  /** null clears the thread part (the topic moved on); undefined leaves it as is. */
  threadId?: string | null;
  /** Display subject for the chip; only meaningful alongside a threadId. */
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

/** Remove focus entirely (the chip's "no focus / all accounts" pick). */
export async function clearConversationFocus(conversationId: string): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ focusAccountId: null, focusThreadId: null, focusThreadSubject: null })
    .where(eq(schema.conversations.id, conversationId));
  emitServerEvent("conversations");
}

/** An @-mention pins a specific email — focus follows the last one attached. */
export function focusFromRefs(refs: EmailRef[] | undefined): FocusPatch | null {
  const last = refs?.[refs.length - 1];
  if (!last) return null;
  return { accountId: last.accountId, threadId: last.threadId, subject: last.subject ?? null };
}

/**
 * What a card says about where the conversation is. Thread-level cards set
 * both parts; account-wide cards (search hits) set the account and CLEAR the
 * thread — the topic has widened beyond one email. Briefing cards carry no
 * top-level account (their items span accounts) and never move focus.
 */
export function focusFromCard(card: AgentCard): FocusPatch | null {
  if (!("account" in card) || !card.account) return null;
  const accountId = card.account.accountId;
  switch (card.kind) {
    case "email_thread":
      return { accountId, threadId: card.threadId, subject: card.subject ?? null };
    case "email_draft":
      return {
        accountId,
        threadId: card.draft.threadId ?? null,
        subject: card.draft.subject ?? null,
      };
    case "email_hits":
      return { accountId, threadId: null };
    default:
      return null;
  }
}

/**
 * The standing-focus note appended to each turn's prompt — what makes focus
 * the tool-call default. Empty string when the conversation has no focus.
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
