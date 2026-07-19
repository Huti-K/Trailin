import { randomUUID } from "node:crypto";
import type { AgentCard, ChatToolCall, EmailRef, MessageCard } from "@trailin/shared";
import { emitServerEvent } from "../core/events.js";
import { moduleLogger, type TurnLogger } from "../core/logger.js";
import { errorMessage } from "../core/utils/util.js";
import { type EnsureConversationInput, ensureConversation } from "../db/conversationStore.js";
import { linkDraftConversation } from "../db/draftStore.js";
import { db, schema, sqlite } from "../db/index.js";
import { serializeRefs } from "./emailRefs.js";
import { applyConversationFocus, focusFromCard, focusFromRefs } from "./focus.js";
import { buildTurnPrompt } from "./prompt.js";
import type { RunHandlers } from "./run.js";
import { type AgentSession, createEphemeralSession, getOrCreateSession } from "./sessionCache.js";

/**
 * The only module that writes turn rows; the chat route and the automation
 * run recorder are its two adapters.
 */

const log = moduleLogger("turnRecorder");

function collectTurnActivity(conversationId: string): {
  cards: MessageCard[];
  toolCalls: ChatToolCall[];
  wrap: (caller?: RunHandlers) => RunHandlers;
} {
  const cards: MessageCard[] = [];
  const toolCalls: ChatToolCall[] = [];
  let textLength = 0;

  const onCard = (toolCallId: string, card: AgentCard) => {
    // A retried tool call replaces its earlier card, not a second entry.
    const existing = cards.findIndex((c) => c.toolCallId === toolCallId);
    if (existing >= 0) cards[existing] = { toolCallId, card };
    else cards.push({ toolCallId, card });

    if (card.kind === "email_draft" && card.draft.draftId) {
      // Fire-and-forget: the link can't fail or stall the turn. Re-emit
      // "drafts" once it exists; the draft tool's own emit can race ahead, and
      // its refetch would miss the conversationId.
      linkDraftConversation(card.account?.accountId ?? "", card.draft.draftId, conversationId)
        .then(() => emitServerEvent("drafts"))
        .catch((err: unknown) => {
          log.warn({ err, conversationId }, "linking the turn's draft to its conversation failed");
        });
    }

    // Cards move the conversation's focus (focus.ts); fire-and-forget for the
    // same reason as the link.
    const focus = focusFromCard(card);
    if (focus) {
      applyConversationFocus(conversationId, focus).catch((err: unknown) => {
        log.warn({ err, conversationId }, "applying the card's conversation focus failed");
      });
    }
  };

  const wrap = (caller: RunHandlers = {}): RunHandlers => ({
    ...caller,
    onTextDelta: (delta) => {
      textLength += delta.length;
      caller.onTextDelta?.(delta);
    },
    onToolStart: (toolCallId, toolName, toolLabel, parameters) => {
      const call: ChatToolCall = {
        id: toolCallId,
        name: toolName,
        label: toolLabel,
        isError: false,
        done: false,
        parameters,
        contentOffset: textLength,
      };
      // A retried tool call replaces its earlier record, not a second entry.
      const existing = toolCalls.findIndex((c) => c.id === toolCallId);
      if (existing >= 0) toolCalls[existing] = call;
      else toolCalls.push(call);
      caller.onToolStart?.(toolCallId, toolName, toolLabel, parameters);
    },
    onToolEnd: (toolCallId, toolName, isError, result) => {
      const call = toolCalls.find((c) => c.id === toolCallId);
      if (call) {
        call.done = true;
        call.isError = isError;
        call.result = result;
      }
      caller.onToolEnd?.(toolCallId, toolName, isError, result);
    },
    onCard: (toolCallId, card) => {
      onCard(toolCallId, card);
      caller.onCard?.(toolCallId, card);
    },
  });

  return { cards, toolCalls, wrap };
}

export function serializeTurnCards(cards: MessageCard[]): string | null {
  return cards.length > 0 ? JSON.stringify(cards) : null;
}

/**
 * Thrown by beginTurn() when a turn is already running for the conversation.
 * pi's Agent rejects a second prompt() while one is in flight, so two
 * overlapping sends both reaching runPrompt would corrupt the transcript: the
 * second user message persisted for a turn the agent never processes. The chat
 * route turns this into a 409.
 */
export class TurnInFlightError extends Error {
  constructor(conversationId: string) {
    super(`a turn is already in flight for conversation ${conversationId}`);
    this.name = "TurnInFlightError";
  }
}

/**
 * The Agent session a turn runs against, as an injectable seam: the real
 * sessions build against the modelRegistry singleton and can't run in tests,
 * which substitute a scripted fake via _setSessionsForTest.
 */
export interface TurnSessions {
  pooled(conversationId: string): Promise<AgentSession>;
  ephemeral(conversationId: string): Promise<AgentSession>;
}

const realSessions: TurnSessions = {
  pooled: getOrCreateSession,
  ephemeral: createEphemeralSession,
};

let sessions: TurnSessions = realSessions;

/** Test-only seam; pass null to restore the real sessions. @internal */
export function _setSessionsForTest(override: TurnSessions | null): void {
  sessions = override ?? realSessions;
}

interface TurnRunOptions {
  prompt: string;
  refs?: EmailRef[];
  session: "pooled" | "ephemeral";
  conversation: EnsureConversationInput;
  /** A mailbox pre-selected in the chat header, applied as focus once the row exists; a later @-mention overrides it. */
  focusAccountId?: string | null;
  handlers?: RunHandlers;
  signal?: AbortSignal;
  log: TurnLogger;
}

export interface Turn {
  run(opts: TurnRunOptions): Promise<{ text: string; cards: MessageCard[] }>;
}

// Conversation ids with a turn in flight, the lock TurnInFlightError enforces.
// Module-level because the chat route and the scheduler share one lock.
const inFlight = new Set<string>();

/**
 * Acquire the in-flight guard for a conversation. Synchronous and separate
 * from Turn.run() so the chat route can answer a collision with a 409 before
 * reply.hijack() takes the response away from Fastify. Throws instead of
 * queuing: a second send for the same conversation is a double-submit, never
 * work to queue.
 */
export function beginTurn(conversationId: string): Turn {
  if (inFlight.has(conversationId)) throw new TurnInFlightError(conversationId);
  inFlight.add(conversationId);

  // run() is single-use: a second call would persist another turn under a
  // guard acquisition it can no longer be trusted to hold.
  let used = false;

  return {
    async run(opts: TurnRunOptions): Promise<{ text: string; cards: MessageCard[] }> {
      if (used) {
        throw new Error(`turn.run() already called for conversation ${conversationId}`);
      }
      used = true;

      let session: AgentSession;
      try {
        // Ensured first and unconditionally: even a turn that never starts
        // leaves the conversation visible for a retry.
        await ensureConversation(conversationId, opts.conversation);
        session =
          opts.session === "pooled"
            ? await sessions.pooled(conversationId)
            : await sessions.ephemeral(conversationId);
      } catch (error) {
        // No session acquired: nothing to close, no user row written, so just
        // release the guard.
        inFlight.delete(conversationId);
        throw error;
      }

      try {
        // The session is built before the user message is persisted: a
        // pooled session rebuilt from the DB (loadHistory) seeds from every row
        // already in `messages`, so inserting this turn's user row first would
        // make it see its own turn as prior history and prompt over it twice.
        //
        // `content` stays the raw prompt (what the UI shows back), while the
        // prompt run against the model below gets the attached-email note
        // appended, so a rebuilt session reconstructs what this turn saw.
        await db.insert(schema.messages).values({
          id: randomUUID(),
          conversationId,
          role: "user",
          content: opts.prompt,
          refs: serializeRefs(opts.refs),
          createdAt: new Date().toISOString(),
        });

        // A mailbox pre-selected before this conversation existed: apply it now
        // that the row does. Written before the @-mention focus below, which is
        // more specific and wins as the last writer.
        if (opts.focusAccountId) {
          await applyConversationFocus(conversationId, {
            accountId: opts.focusAccountId,
          }).catch((err: unknown) => {
            opts.log.warn({ err }, "applying the pre-selected account focus failed");
          });
        }

        // Focus follows an @-mention (last wins); buildTurnPrompt reads the
        // standing focus back AFTER this write, so the turn's focus note
        // reflects it.
        const refFocus = focusFromRefs(opts.refs);
        if (refFocus) {
          await applyConversationFocus(conversationId, refFocus).catch((err: unknown) => {
            opts.log.warn({ err }, "applying the @-mention's conversation focus failed");
          });
        }

        const collector = collectTurnActivity(conversationId);
        const handlers = collector.wrap(opts.handlers);

        const recordOutcome = async (content: string): Promise<void> => {
          await db.insert(schema.messages).values({
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content,
            cards: serializeTurnCards(collector.cards),
            toolCalls: collector.toolCalls.length > 0 ? JSON.stringify(collector.toolCalls) : null,
            createdAt: new Date().toISOString(),
          });
          emitServerEvent("conversations");
        };

        let text: string;
        try {
          // session.runTurn (not the bare runPrompt) so the session's inFlight
          // bookkeeping covers this call: sessionCache's idle sweep won't close
          // a toolset out from under a turn that went through runTurn.
          // buildTurnPrompt decorates the raw prompt with its per-turn notes
          // right before it reaches the model.
          text = await session.runTurn(
            await buildTurnPrompt(opts.prompt, opts.refs, conversationId),
            handlers,
            opts.signal,
            opts.log,
          );
        } catch (error) {
          // Cancelled: the signal fired mid-turn (client disconnect, timeout).
          // Record the cancellation, keeping whatever cards already landed: a
          // draft may exist and its card still renders.
          if (opts.signal?.aborted) {
            await recordOutcome("This reply was cancelled before it finished.");
            throw new Error("turn cancelled: the signal was aborted before the turn finished");
          }
          // Failed: the agent threw on its own.
          await recordOutcome(`This turn failed: ${errorMessage(error)}`);
          throw error;
        }

        // Post-resolve race: runPrompt returned normally but the signal
        // aborted at almost the same instant. Shipping this as success would
        // deliver a reply the caller already gave up on; treat it as cancelled.
        if (opts.signal?.aborted) {
          await recordOutcome("This reply was cancelled before it finished.");
          throw new Error("turn cancelled: the signal was aborted as the turn resolved");
        }

        await recordOutcome(text);
        return { text, cards: collector.cards };
      } finally {
        // An ephemeral session belongs to this run alone, so this run closes
        // it. A pooled session stays open for the conversation's next turn.
        if (opts.session === "ephemeral") {
          await session.toolset.close().catch((error: unknown) => {
            opts.log.warn({ err: error }, "closing the run's MCP sessions failed");
          });
        }
        inFlight.delete(conversationId);
      }
    },
  };
}

const RECOVERY_MARKER =
  "This turn was interrupted by a server restart before a reply was produced. Send your message again to continue.";

/**
 * A conversation left with a dangling user message and no reply means a true
 * crash: the process died between the user-message insert and the outcome
 * insert. Every other terminal outcome is capped by Turn.run() before it
 * returns, so this restart marker is always truthful. On boot, cap those
 * stranded conversations so the UI doesn't show a message that looks ignored.
 */
export async function recoverInterruptedTurns(): Promise<void> {
  // Each chat conversation whose newest turn row is from the user. Scoped to
  // type='chat': a crashed automation records its own error on the run row,
  // and "send again" is meaningless there. Compaction rows aren't replies. The
  // rowid tie-break makes "newest" total when two rows share a millisecond.
  const stranded = sqlite
    .prepare(
      `SELECT m.conversation_id AS conversationId
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.type = 'chat'
        WHERE m.role = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM messages n
             WHERE n.conversation_id = m.conversation_id
               AND n.role IN ('user', 'assistant')
               AND (n.created_at > m.created_at
                    OR (n.created_at = m.created_at AND n.rowid > m.rowid))
          )`,
    )
    .all() as { conversationId: string }[];

  if (stranded.length === 0) return;

  const now = new Date().toISOString();
  const rows = stranded.map(({ conversationId }) => ({
    id: randomUUID(),
    conversationId,
    role: "assistant" as const,
    content: RECOVERY_MARKER,
    createdAt: now,
  }));
  await db.insert(schema.messages).values(rows);

  log.warn({ count: rows.length }, "closed out chat turns interrupted by a restart");
  emitServerEvent("conversations");
}
