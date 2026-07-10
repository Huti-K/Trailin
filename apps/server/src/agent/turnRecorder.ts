import { randomUUID } from "node:crypto";
import type { MessageCard } from "@trailin/shared";
import { db, schema, sqlite } from "../db/index.js";
import { emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import { errorMessage } from "../util.js";
import { createEphemeralSession, getOrCreateSession, type AgentSession } from "./emailAgent.js";
import type { RunHandlers, TurnLogger } from "./run.js";
import { collectTurnCards, serializeTurnCards } from "./turnCards.js";

/**
 * Writes turns: one user message and the assistant reply that ends it, with
 * its cards. This is the ONLY module that writes turn rows — the chat route
 * (routes/chat.ts) and the automation scheduler (automations/scheduler.ts)
 * are its two adapters, each supplying a prompt, a session flavor, and
 * whatever streaming/timeout concerns are theirs alone (SSE for chat, a
 * deadline AbortController for the scheduler). See CONTEXT.md for the
 * vocabulary this file is written against: turn, run, card, draft link.
 */

export { serializeTurnCards } from "./turnCards.js";

const log = moduleLogger("turnRecorder");

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
 * seam — defaulting to the real emailAgent.ts functions below — because the
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

/** Test-only seam: pass null to restore the real emailAgent-backed sessions. */
export function _setSessionsForTest(override: TurnSessions | null): void {
  sessions = override ?? realSessions;
}

export interface TurnRunOptions {
  prompt: string;
  session: "pooled" | "ephemeral";
  /** The caller's own streaming pass-through (chat's SSE handlers); the scheduler passes none. */
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
        session = opts.session === "pooled" ? await sessions.pooled(conversationId) : await sessions.ephemeral();
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
        await db.insert(schema.messages).values({
          id: randomUUID(),
          conversationId,
          role: "user",
          content: opts.prompt,
          createdAt: new Date().toISOString(),
        });

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
          // inFlight bookkeeping covers this call too — emailAgent.ts's idle
          // sweep refuses to close a session's toolset out from under a turn
          // still running against it, but only for turns that went through
          // runTurn.
          text = await session.runTurn(opts.prompt, handlers, opts.signal, opts.log);
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
        // the conversation's next turn (see emailAgent.ts's LRU/idle sweep).
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
 * Every terminal outcome (completed, failed, cancelled) is now capped by
 * Turn.run() above before it returns or throws, so the only way a
 * conversation can still be left with a dangling user message and no reply
 * is a true crash — the process dying between the user-message insert and
 * the outcome insert, taking the in-memory agent context with it. That is
 * the "stranded" turn (see CONTEXT.md): the restart marker this writes is
 * finally always truthful, since every other way a turn can end already
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
