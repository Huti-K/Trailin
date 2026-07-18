import { randomUUID } from "node:crypto";
import type { AgentCard, EmailRef, MessageCard } from "@trailin/shared";
import { type EnsureConversationInput, ensureConversation } from "../db/conversationStore.js";
import { linkDraftConversation } from "../db/draftStore.js";
import { db, schema, sqlite } from "../db/index.js";
import { emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import { errorMessage } from "../utils/util.js";
import { decoratePrompt, serializeRefs } from "./emailRefs.js";
import {
  applyConversationFocus,
  conversationFocusNote,
  focusFromCard,
  focusFromRefs,
} from "./focus.js";
import { buildTurnTimeNote } from "./prompt.js";
import type { RunHandlers, TurnLogger } from "./run.js";
import { type AgentSession, createEphemeralSession, getOrCreateSession } from "./sessionCache.js";

/**
 * Writes turns: one user message and the assistant reply that ends it, with
 * its cards. This is the ONLY module that writes turn rows — the chat route
 * (routes/chat.ts) and the automation run recorder (automations/
 * runRecorder.ts) are its two adapters, each supplying a prompt, a session
 * flavor, and whatever streaming/timeout concerns are theirs alone (SSE for
 * chat, a deadline AbortSignal for a run). Turn.run() also ensures the
 * turn's parent Conversation row (db/conversationStore.ts) before writing
 * to it, using the type/title its caller supplies — the one place either
 * adapter has to remember is what to call the conversation, not when to
 * create it. See CONTEXT.md for the vocabulary this file is written
 * against: turn, run, card, draft link.
 */

const log = moduleLogger("turnRecorder");

/**
 * Collects the cards one agent turn emits so the caller can persist them with
 * the assistant message, and links every draft the turn creates back to this
 * conversation on its agent_drafts snapshot — that link is what lets the
 * Drafts list reopen the exact conversation a draft came from. Used by both
 * the chat route and the automation runner (a run id doubles as its
 * conversation id).
 */
function collectTurnCards(conversationId: string): {
  cards: MessageCard[];
  onCard: (toolCallId: string, card: AgentCard) => void;
} {
  const cards: MessageCard[] = [];

  const onCard = (toolCallId: string, card: AgentCard) => {
    // A retried tool call replaces its earlier card, same as the live chat UI.
    const existing = cards.findIndex((c) => c.toolCallId === toolCallId);
    if (existing >= 0) cards[existing] = { toolCallId, card };
    else cards.push({ toolCallId, card });

    if (card.kind === "email_draft" && card.draft.draftId) {
      // Fire-and-forget: the link is a navigation nicety and must never fail
      // or stall the turn. Re-emit "drafts" once the link exists — the draft
      // tool's own emit can race ahead of this update, and the refetch it
      // triggers would miss the conversationId.
      linkDraftConversation(card.account?.accountId ?? "", card.draft.draftId, conversationId)
        .then(() => emitServerEvent("drafts"))
        .catch((err: unknown) => {
          log.warn({ err, conversationId }, "linking the turn's draft to its conversation failed");
        });
    }

    // Cards are also how the agent's activity moves the conversation's focus
    // (agent/focus.ts) — fire-and-forget for the same reason as the link.
    const focus = focusFromCard(card);
    if (focus) {
      applyConversationFocus(conversationId, focus).catch((err: unknown) => {
        log.warn({ err, conversationId }, "applying the card's conversation focus failed");
      });
    }
  };

  return { cards, onCard };
}

/** Serializes a turn's cards for the messages.cards column; null when there were none. */
export function serializeTurnCards(cards: MessageCard[]): string | null {
  return cards.length > 0 ? JSON.stringify(cards) : null;
}

/**
 * Thrown by beginTurn() when a turn is already running for the conversation.
 * pi's Agent rejects a second prompt() while one is in flight, so letting two
 * overlapping sends both reach runPrompt would corrupt the transcript: the
 * second user message would get persisted for a turn the agent never
 * actually processes. The chat route turns this into a 409; the scheduler
 * never triggers it in practice — its own runningAutomations guard already
 * keeps one run per automation, and every run mints a fresh run id.
 */
export class TurnInFlightError extends Error {
  constructor(conversationId: string) {
    super(`a turn is already in flight for conversation ${conversationId}`);
    this.name = "TurnInFlightError";
  }
}

/**
 * Resolves the Agent session a turn runs against. Exists as an injectable
 * seam — defaulting to the real sessionCache.ts functions below — because the
 * real sessions build an Agent against the modelRegistry singleton (live
 * model config, live credentials) and cannot run in tests; tests substitute
 * a scripted fake Agent through _setSessionsForTest instead.
 */
export interface TurnSessions {
  /** One long-lived session per conversation, rebuilt from its prior turns. */
  pooled(conversationId: string): Promise<AgentSession>;
  /** A throwaway session for one automation run. */
  ephemeral(): Promise<AgentSession>;
}

const realSessions: TurnSessions = {
  pooled: getOrCreateSession,
  ephemeral: createEphemeralSession,
};

let sessions: TurnSessions = realSessions;

/**
 * Test-only seam: pass null to restore the real sessionCache-backed sessions.
 * @internal
 */
export function _setSessionsForTest(override: TurnSessions | null): void {
  sessions = override ?? realSessions;
}

interface TurnRunOptions {
  prompt: string;
  /** Composer @-mentions attached to this turn's user message; see agent/emailRefs.ts. */
  refs?: EmailRef[];
  session: "pooled" | "ephemeral";
  /**
   * Type/title for this turn's parent Conversation row (db/conversationStore.ts,
   * ensureConversation). Every caller computes its own title — chat.ts uses the
   * opening words of the user's message, runRecorder.ts uses "Run: <automation name>".
   */
  conversation: EnsureConversationInput;
  /**
   * A mailbox the user pre-selected in the chat header before this conversation
   * existed. Applied as the conversation's focus once the row is ensured, so
   * even this first turn defaults to that account. Only meaningful on a brand-new
   * conversation; a later @-mention on the same turn still overrides it.
   */
  focusAccountId?: string | null;
  /** The caller's own streaming pass-through (chat's SSE handlers); a run passes none. */
  handlers?: RunHandlers;
  signal?: AbortSignal;
  log: TurnLogger;
}

export interface Turn {
  run(opts: TurnRunOptions): Promise<{ text: string; cards: MessageCard[] }>;
}

// Conversation ids with a turn currently in flight — the correctness guard
// TurnInFlightError enforces. Module-level rather than per-caller state
// because the chat route and the scheduler share this one lock: whichever of
// them (or which second request) gets here first for a given id wins.
const inFlight = new Set<string>();

/**
 * Acquire the in-flight guard for a conversation. Synchronous and separate
 * from Turn.run() on purpose: the chat route must be able to answer a
 * collision with a real 409 status code, and that is only possible *before*
 * reply.hijack() takes the response away from Fastify. Throws
 * TurnInFlightError instead of queuing — a second send for the same
 * conversation is a double-submit or a second tab, never legitimate work to
 * queue up behind the first.
 */
export function beginTurn(conversationId: string): Turn {
  if (inFlight.has(conversationId)) throw new TurnInFlightError(conversationId);
  inFlight.add(conversationId);

  // run() is single-use: once a Turn has produced its one terminal row
  // (completed/failed/cancelled), calling it again would try to persist a
  // second turn under the same guard acquisition, which the guard itself
  // can no longer be trusted to have protected (it may already be released).
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
        // (the session below fails to build) must leave the conversation
        // visible for the user to retry.
        await ensureConversation(conversationId, opts.conversation);
        session =
          opts.session === "pooled"
            ? await sessions.pooled(conversationId)
            : await sessions.ephemeral();
      } catch (error) {
        // Never acquired a session, so there's nothing to close and no user
        // row was written — just give the guard back.
        inFlight.delete(conversationId);
        throw error;
      }

      try {
        // The session must exist before the user message is persisted: a
        // pooled session rebuilt from the DB (getOrCreateSession ->
        // loadHistory) seeds itself from every row already in `messages`, so
        // inserting this turn's user row first would make the rebuilt
        // session see its own turn as prior history and prompt over it a
        // second time.
        //
        // `content` stays the raw prompt — it's what the UI shows back to the
        // user — while the prompt actually run against the model (below) gets
        // the attached-email note appended, so a rebuilt session (loadHistory)
        // can reconstruct exactly what this turn saw.
        await db.insert(schema.messages).values({
          id: randomUUID(),
          conversationId,
          role: "user",
          content: opts.prompt,
          refs: serializeRefs(opts.refs),
          createdAt: new Date().toISOString(),
        });

        // A mailbox pre-selected in the header chip before this (new)
        // conversation existed: apply it now that the row does, so this first
        // turn's focus note already reflects it. Written before the @-mention
        // focus below, which is more specific and wins as the last writer.
        if (opts.focusAccountId) {
          await applyConversationFocus(conversationId, {
            accountId: opts.focusAccountId,
          }).catch((err: unknown) => {
            opts.log.warn({ err }, "applying the pre-selected account focus failed");
          });
        }

        // Focus follows an @-mention (last one wins), and the standing focus
        // is read back AFTER that write so this turn's note reflects it. The
        // note is what makes focus the agent's tool-call default.
        const refFocus = focusFromRefs(opts.refs);
        if (refFocus) {
          await applyConversationFocus(conversationId, refFocus).catch((err: unknown) => {
            opts.log.warn({ err }, "applying the @-mention's conversation focus failed");
          });
        }
        const focusNote = await conversationFocusNote(conversationId).catch(() => "");
        // The clock rides the turn prompt, not the system prompt, so the model
        // knows "now" without invalidating the cached system-prompt prefix
        // (see buildSystemPrompt's cache invariant in agent/prompt.ts).
        const timeNote = await buildTurnTimeNote().catch(() => "");

        // Collects this turn's cards for the outcome row below (and links
        // any created draft back to this conversation — collectTurnCards'
        // own job). The caller's onCard (chat's SSE "card" event) must see
        // every card too, so wrap rather than pick one: both run on every card.
        const collector = collectTurnCards(conversationId);
        const callerOnCard = opts.handlers?.onCard;
        const handlers: RunHandlers = {
          ...opts.handlers,
          onCard: (toolCallId, card) => {
            collector.onCard(toolCallId, card);
            callerOnCard?.(toolCallId, card);
          },
        };

        const recordOutcome = async (content: string): Promise<void> => {
          await db.insert(schema.messages).values({
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content,
            cards: serializeTurnCards(collector.cards),
            createdAt: new Date().toISOString(),
          });
          emitServerEvent("conversations");
        };

        let text: string;
        try {
          // session.runTurn (not the bare runPrompt) so the session's own
          // inFlight bookkeeping covers this call too — sessionCache.ts's idle
          // sweep refuses to close a session's toolset out from under a turn
          // still running against it, but only for turns that went through
          // runTurn. The prompt is decorated with any attached-email notes
          // right before it reaches the model.
          text = await session.runTurn(
            decoratePrompt(opts.prompt, opts.refs) + timeNote + focusNote,
            handlers,
            opts.signal,
            opts.log,
          );
        } catch (error) {
          // Cancelled: the agent threw because the signal fired mid-turn (a
          // client disconnect, an automation timeout). Record the
          // cancellation rather than the raw abort error, and keep whatever
          // cards already landed — a draft may already exist and its card
          // must still render.
          if (opts.signal?.aborted) {
            await recordOutcome("This reply was cancelled before it finished.");
            throw new Error("turn cancelled: the signal was aborted before the turn finished");
          }
          // Failed: the agent (or something inside it) threw on its own.
          await recordOutcome(`This turn failed: ${errorMessage(error)}`);
          throw error;
        }

        // Post-resolve race: runPrompt returned normally, but the signal was
        // aborted at almost the same instant — a timeout or disconnect
        // landing exactly as the turn finished. Recording this as a clean
        // success would ship a reply the caller already gave up on; treat it
        // as cancelled instead, same as the threw-and-aborted case above.
        if (opts.signal?.aborted) {
          await recordOutcome("This reply was cancelled before it finished.");
          throw new Error("turn cancelled: the signal was aborted as the turn resolved");
        }

        await recordOutcome(text);
        return { text, cards: collector.cards };
      } finally {
        // An ephemeral session belongs to nobody but this run — this run
        // created it, so this run closes it. A pooled session stays open for
        // the conversation's next turn (see sessionCache.ts's LRU/idle sweep).
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
 * Every terminal outcome (completed, failed, cancelled) is capped by
 * Turn.run() above before it returns or throws, so the only way a
 * conversation can be left with a dangling user message and no reply
 * is a true crash — the process dying between the user-message insert and
 * the outcome insert, taking the in-memory agent context with it. That is
 * the "stranded" turn (see CONTEXT.md): the restart marker this writes is
 * always truthful, since every other way a turn can end already
 * writes its own row. On boot, cap those conversations with the marker so
 * the UI doesn't show a message that looks ignored. Mirrors the orphaned-run
 * recovery in automations/scheduler.ts.
 */
export async function recoverInterruptedTurns(): Promise<void> {
  // Each chat conversation whose newest message row is from the user. Scoped
  // to type='chat': a crashed or timed-out automation run records its own
  // error on the run row (scheduler.ts), and "send your message again" is
  // meaningless there. The rowid tie-break makes "newest" total even if two
  // rows share a millisecond.
  const stranded = sqlite
    .prepare(
      `SELECT m.conversation_id AS conversationId
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.type = 'chat'
        WHERE m.role = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM messages n
             WHERE n.conversation_id = m.conversation_id
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
