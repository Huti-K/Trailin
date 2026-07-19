import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ChatStreamEvent } from "@trailin/shared";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { parseStoredCards } from "../agent/cards.js";
import { parseStoredRefs } from "../agent/emailRefs.js";
import { applyConversationFocus, clearConversationFocus } from "../agent/focus.js";
import { parseStoredToolCalls } from "../agent/history.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { disposeSession } from "../agent/sessionCache.js";
import { beginTurn, type Turn, TurnInFlightError } from "../agent/turnRecorder.js";
import { badRequest, conflict, requireRow } from "../core/errors.js";
import { emitServerEvent } from "../core/events.js";
import { errorMessage } from "../core/utils/util.js";
import { deleteConversationCascade } from "../db/conversationStore.js";
import { db, lazyStatement, schema } from "../db/index.js";
import { likeContains, likePattern } from "../db/like.js";
import { buildFtsMatch } from "../db/sql.js";
import { openSse } from "./sse.js";

const conversationsQuery = Type.Object({
  q: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

const idParams = Type.Object({ id: Type.String() });

const conversationPatchBody = Type.Object({
  title: Type.Optional(Type.String()),
  focusAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const chatBody = Type.Object({
  conversationId: Type.Optional(Type.String()),
  focusAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  message: Type.String(),
  // Composer @-mentions (agent/emailRefs.ts): appended to the prompt run as an
  // authoritative note, while the persisted row keeps `message` raw.
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

// Conversation ids with a visibly in-flight turn, only for the history rail's
// "responding…" badge (the `running` flag below). Deliberately separate from the
// correctness guard in agent/turnRecorder.ts (beginTurn/TurnInFlightError): this
// Set only drives a UI badge, so it's safe to manage locally around the request.
const runningConversations = new Set<string>();

const messageMatchStmt = lazyStatement(`
  SELECT DISTINCT m.conversation_id AS conversationId
  FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid
  WHERE messages_fts MATCH ?
`);

export const chatRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/conversations", { schema: { querystring: conversationsQuery } }, async (req) => {
    const q = req.query.q?.trim();
    const limit = Math.min(req.query.limit ?? 50, 200);
    const offset = req.query.offset ?? 0;

    // buildFtsMatch is null when the query has no word/number chars, so "***"
    // degrades to a title-only match rather than an empty MATCH (which SQLite rejects).
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
      // Validate before the existence check: a malformed request is a 400
      // regardless of whether the id resolves.
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

      // A manual pick sets the account and clears the thread; null clears focus
      // entirely. Both emit "conversations" themselves.
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
    // A turn still running for this conversation could insert its assistant row
    // (turnRecorder's recordOutcome) after the delete below; refuse with the
    // same 409 as a concurrent send rather than race it. runningConversations is
    // set synchronously right after beginTurn with no await between, so this
    // can't miss a just-started turn.
    if (runningConversations.has(req.params.id)) {
      throw conflict("a reply is in progress for this conversation");
    }
    // Dispose the live session before deleting rows, not after: once this
    // resolves nothing can start a new turn (the next getOrCreateSession would
    // rebuild from `messages`, about to be gone), so no write lands after the
    // delete commits.
    await disposeSession(req.params.id);
    deleteConversationCascade(req.params.id);
    return { ok: true };
  });

  app.get("/api/chat/system-prompt", async () => ({ prompt: await buildSystemPrompt() }));

  app.get("/api/conversations/:id/messages", { schema: { params: idParams } }, async (req) => {
    // Compaction rows are model-history bookkeeping, not the visible transcript.
    const rows = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, req.params.id),
          inArray(schema.messages.role, ["user", "assistant"]),
        ),
      )
      .orderBy(schema.messages.createdAt);

    return rows.map(({ cards, toolCalls, refs, compactionCutoff: _, ...row }) => ({
      ...row,
      cards: parseStoredCards(cards),
      toolCalls: parseStoredToolCalls(toolCalls),
      refs: parseStoredRefs(refs),
    }));
  });

  app.post("/api/chat", { schema: { body: chatBody } }, async (req, reply) => {
    const message = req.body.message.trim();
    if (!message) throw badRequest("message is required");

    // Resolve the id and acquire the turn guard before hijacking the reply: once
    // hijack() hands over the socket there is no way to answer with an HTTP
    // status, so an overlapping send is refused here.
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

    // Abort the turn when the client disconnects, so an abandoned tab stops
    // burning tool calls and tokens.
    const controller = new AbortController();
    const stream = openSse<ChatStreamEvent>(reply, () => controller.abort());
    const send = (event: ChatStreamEvent) => stream.send(event);

    let streamedText = "";
    try {
      runningConversations.add(conversationId);
      emitServerEvent("conversations");

      send({ type: "conversation", conversationId });

      // ensureConversation (in turnRecorder) is idempotent, so a client-supplied
      // id naming a conversation this server never recorded (stale client state
      // after a delete) never orphans this turn's messages. No other route
      // creates type: "chat" rows.
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
      // turn.run() already closed out the transcript (including a client-
      // disconnect abort, which surfaces here); this only notifies a still-
      // connected client. stream.send is a no-op once the stream has ended.
      req.log.error(error, "chat failed");
      send({ type: "error", message: errorMessage(error) });
    } finally {
      runningConversations.delete(conversationId);
      emitServerEvent("conversations");
      stream.end();
    }
  });
};
