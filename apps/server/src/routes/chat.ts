import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ChatStreamEvent, ChatToolCall } from "@trailin/shared";
import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { parseStoredCards } from "../agent/cards.js";
import { parseStoredRefs } from "../agent/emailRefs.js";
import { applyConversationFocus, clearConversationFocus } from "../agent/focus.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { disposeSession } from "../agent/sessionCache.js";
import { beginTurn, type Turn, TurnInFlightError } from "../agent/turnRecorder.js";
import { deleteConversationCascade } from "../db/conversationStore.js";
import { db, lazyStatement, schema } from "../db/index.js";
import { likeContains, likePattern } from "../db/like.js";
import { buildFtsMatch } from "../db/sql.js";
import { badRequest, conflict, requireRow } from "../errors.js";
import { emitServerEvent } from "../events.js";
import { errorMessage } from "../utils/util.js";
import { openSse } from "./sse.js";

const conversationsQuery = Type.Object({
  q: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

const idParams = Type.Object({ id: Type.String() });

const conversationPatchBody = Type.Object({
  title: Type.Optional(Type.String()),
  /** Manual focus pick from the chat header chip: an account id, or null to clear focus. */
  focusAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const chatBody = Type.Object({
  conversationId: Type.Optional(Type.String()),
  // A mailbox pre-selected in the header chip before this conversation existed;
  // applied as the new conversation's focus so even the first turn respects it.
  focusAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  message: Type.String(),
  // Composer @-mentions: emails the user explicitly pinned to this message.
  // See agent/emailRefs.ts — these become an authoritative note appended to
  // the prompt actually run, while the persisted row keeps `message` raw.
  refs: Type.Optional(
    Type.Array(
      Type.Object({
        threadId: Type.String(),
        accountId: Type.String(),
        accountName: Type.Optional(Type.String()),
        messageId: Type.Optional(Type.String()),
        subject: Type.Optional(Type.String()),
        from: Type.Optional(Type.String()),
        date: Type.Optional(Type.String()),
      }),
      { maxItems: 8 },
    ),
  ),
});

// Conversation ids with a visibly in-flight turn, purely for the history
// rail's live "responding…" indicator (the `running` flag below). This is
// deliberately separate from the correctness guard in agent/turnRecorder.ts
// (beginTurn/TurnInFlightError): that guard exists so a second overlapping
// send can never corrupt the transcript, and is released the instant
// Turn.run() ends, wherever it's called from. This Set only drives a UI
// badge and is safe to manage locally, right around the request lifecycle.
const runningConversations = new Set<string>();

/**
 * Message-content half of conversation search: messages_fts is the FTS5
 * external-content index over `messages` (db/schemaSteps.ts), kept in sync by
 * insert/update/delete triggers, so this never scans message bodies with
 * LIKE. Every hit is joined back to `messages` by rowid to read the owning
 * conversation id; DISTINCT collapses a conversation with several matching
 * messages to one row. Same idiom as search/sources.ts's messageHitsStmt.
 */
const messageMatchStmt = lazyStatement(`
  SELECT DISTINCT m.conversation_id AS conversationId
  FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid
  WHERE messages_fts MATCH ?
`);

function parseToolCalls(value: string | null): ChatToolCall[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (call): call is ChatToolCall =>
        typeof call === "object" &&
        call !== null &&
        typeof (call as ChatToolCall).id === "string" &&
        typeof (call as ChatToolCall).name === "string",
    );
  } catch {
    return undefined;
  }
}

export const chatRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/conversations", { schema: { querystring: conversationsQuery } }, async (req) => {
    const q = req.query.q?.trim();
    const limit = Math.min(req.query.limit ?? 50, 200);
    const offset = req.query.offset ?? 0;

    // Matches conversations by title (LIKE — titles are short and few), or
    // that contain at least one message hit against messages_fts. buildFtsMatch
    // mirrors search/sources.ts's searchChats: null when the query has no
    // word/number characters, so a query like "***" degrades to a title-only
    // match rather than an empty MATCH expression (which SQLite rejects).
    const pattern = q ? likeContains(q) : undefined;
    const ftsMatch = q ? buildFtsMatch(q, "AND") : null;
    const matchedConversationIds = ftsMatch
      ? (messageMatchStmt().all(ftsMatch) as { conversationId: string }[]).map(
          (row) => row.conversationId,
        )
      : [];
    const where = pattern
      ? or(
          likePattern(schema.conversations.title, pattern),
          ...(matchedConversationIds.length > 0
            ? [inArray(schema.conversations.id, matchedConversationIds)]
            : []),
        )
      : undefined;

    const itemsQuery = db.select().from(schema.conversations);
    const items = await (where ? itemsQuery.where(where) : itemsQuery)
      .orderBy(desc(schema.conversations.createdAt))
      .limit(limit)
      .offset(offset);

    const totalQuery = db.select({ count: sql<number>`count(*)` }).from(schema.conversations);
    const [totalRow] = await (where ? totalQuery.where(where) : totalQuery);

    return {
      items: items.map((item) => ({ ...item, running: runningConversations.has(item.id) })),
      total: Number(totalRow?.count ?? 0),
    };
  });

  app.patch(
    "/api/conversations/:id",
    { schema: { params: idParams, body: conversationPatchBody } },
    async (req) => {
      const { title, focusAccountId } = req.body;
      if (title === undefined && focusAccountId === undefined) {
        throw badRequest("nothing to update");
      }
      // Input validation precedes the existence check — a malformed request
      // is a 400 regardless of whether the id resolves.
      const trimmed = title?.trim();
      if (title !== undefined && !trimmed) throw badRequest("title is required");
      await requireRow(
        db
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, req.params.id)),
        "not found",
      );

      if (trimmed) {
        await db
          .update(schema.conversations)
          .set({ title: trimmed })
          .where(eq(schema.conversations.id, req.params.id));
        emitServerEvent("conversations");
      }

      // A manual pick sets the account and clears the thread part (the user
      // is redirecting the conversation, not pinning an email); null removes
      // focus entirely. Both emit "conversations" themselves.
      if (focusAccountId === null) {
        await clearConversationFocus(req.params.id);
      } else if (focusAccountId !== undefined) {
        await applyConversationFocus(req.params.id, {
          accountId: focusAccountId,
          threadId: null,
        });
      }
      return { ok: true };
    },
  );

  app.delete("/api/conversations/:id", { schema: { params: idParams } }, async (req) => {
    await requireRow(
      db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, req.params.id)),
      "not found",
    );
    // A turn currently running for this conversation can still insert its
    // assistant row (turnRecorder.ts's recordOutcome) after the delete below —
    // refuse instead of racing it, same 409 shape POST /api/chat itself
    // returns for a second concurrent send. runningConversations is added
    // synchronously right after beginTurn acquires the real in-flight guard,
    // with no `await` between the two, so this check can't miss a turn that
    // only just started.
    if (runningConversations.has(req.params.id)) {
      throw conflict("a reply is in progress for this conversation");
    }
    // Drop the live agent session before deleting rows, not after: once this
    // resolves, nothing can start a new turn against this conversationId (the
    // next getOrCreateSession would rebuild from `messages`, which is about
    // to be gone), so no write can land after the delete below commits.
    await disposeSession(req.params.id);
    deleteConversationCascade(req.params.id);
    return { ok: true };
  });

  app.get("/api/chat/system-prompt", async () => ({ prompt: await buildSystemPrompt() }));

  app.get("/api/conversations/:id/messages", { schema: { params: idParams } }, async (req) => {
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, req.params.id))
      .orderBy(schema.messages.createdAt);

    // The cards/refs columns are JSON blobs internally; the API ships parsed values.
    return rows.map(({ cards, toolCalls, refs, ...row }) => ({
      ...row,
      cards: parseStoredCards(cards),
      toolCalls: parseToolCalls(toolCalls),
      refs: parseStoredRefs(refs),
    }));
  });

  app.post("/api/chat", { schema: { body: chatBody } }, async (req, reply) => {
    const message = req.body.message.trim();
    if (!message) throw badRequest("message is required");

    // Resolve the id and acquire the turn guard before hijacking the reply —
    // once hijack() hands the socket over there is no way left to answer
    // with a real HTTP status code, so an overlapping send has to be turned
    // away here. A brand-new conversation's id is freshly minted and can
    // never already be in flight, so this applies uniformly whether or not
    // the client sent one.
    const conversationId = req.body.conversationId ?? randomUUID();
    let turn: Turn;
    try {
      turn = beginTurn(conversationId);
    } catch (error) {
      if (error instanceof TurnInFlightError) {
        throw conflict("a reply is already in progress for this conversation");
      }
      throw error;
    }

    // Stop the turn as soon as the client disconnects, so an abandoned tab
    // doesn't keep burning tool calls and model tokens.
    const controller = new AbortController();
    const stream = openSse<ChatStreamEvent>(reply, () => controller.abort());
    const send = (event: ChatStreamEvent) => stream.send(event);

    let streamedText = "";
    try {
      runningConversations.add(conversationId);
      emitServerEvent("conversations");

      send({ type: "conversation", conversationId });

      // turnRecorder ensures the parent Conversation row (type "chat") before
      // writing this turn's messages, using the title below. This fires for
      // every freshly minted id, but a client-supplied id can also name a
      // conversation this server never recorded (e.g. stale client state
      // after a delete) — either way, ensureConversation is idempotent, so
      // this turn's messages never end up orphaned against a nonexistent
      // conversation. No other route creates type: "chat" rows (automations/
      // runRecorder.ts creates its own type: "automation" rows, keyed to the
      // run id).
      let thinkingSent = false;
      const { text } = await turn.run({
        prompt: message,
        refs: req.body.refs,
        focusAccountId: req.body.focusAccountId,
        session: "pooled",
        conversation: { type: "chat", title: message.slice(0, 80) },
        handlers: {
          onTextDelta: (delta) => {
            streamedText += delta;
            send({ type: "text_delta", delta });
          },
          // At most one per turn — it only drives the UI's "thinking…" placeholder.
          onThinking: () => {
            if (!thinkingSent) {
              thinkingSent = true;
              send({ type: "thinking" });
            }
          },
          onToolStart: (toolCallId, toolName, toolLabel, parameters) => {
            send({
              type: "tool_start",
              toolCallId,
              toolName,
              toolLabel,
              parameters,
              contentOffset: streamedText.length,
            });
          },
          onToolUpdate: (toolCallId, toolName, detail) => {
            send({ type: "tool_update", toolCallId, toolName, detail });
          },
          onToolEnd: (toolCallId, toolName, isError, result) => {
            send({ type: "tool_end", toolCallId, toolName, isError, result });
          },
          onCard: (toolCallId, card) => {
            send({ type: "card", toolCallId, card });
          },
        },
        signal: controller.signal,
        log: req.log.child({ conversationId }),
      });

      send({ type: "done", text });
    } catch (error) {
      // A client-disconnect abort surfaces here too (the recorder rethrows
      // after writing the cancelled row); stream.send already suppresses
      // writes once the stream has ended. The transcript is already closed
      // out one way or another by turn.run() itself — this is only about
      // telling a still-connected client that something went wrong.
      req.log.error(error, "chat failed");
      send({ type: "error", message: errorMessage(error) });
    } finally {
      runningConversations.delete(conversationId);
      emitServerEvent("conversations");
      stream.end();
    }
  });
};
