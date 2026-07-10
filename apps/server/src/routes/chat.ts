import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { desc, eq, inArray, or, sql } from "drizzle-orm";
import type { ChatStreamEvent, ChatToolCall } from "@trailin/shared";
import { db, schema, sqlite } from "../db/index.js";
import { parseStoredCards } from "../agent/cards.js";
import { buildSystemPrompt, disposeSession } from "../agent/emailAgent.js";
import { beginTurn, TurnInFlightError, type Turn } from "../agent/turnRecorder.js";
import { emitServerEvent } from "../events.js";
import { errorMessage, escapeLikeInput, likePattern } from "../util.js";

interface ChatBody {
  conversationId?: string;
  message: string;
}

// Conversation ids with a visibly in-flight turn, purely for the history
// rail's live "responding…" indicator (the `running` flag below). This is
// deliberately separate from the correctness guard in agent/turnRecorder.ts
// (beginTurn/TurnInFlightError): that guard exists so a second overlapping
// send can never corrupt the transcript, and is released the instant
// Turn.run() ends, wherever it's called from. This Set only drives a UI
// badge and is safe to manage locally, right around the request lifecycle.
const runningConversations = new Set<string>();

// Same two-statement shape as the writes in agent/turnRecorder.ts, wrapped in
// one SQLite transaction so a crash or error between the two can never leave
// a conversation deleted with its messages still around (or vice versa). See
// automations.ts's pinExclusively / mailStore.ts's applyTxn for the idiom.
const deleteConversation = sqlite.transaction((id: string) => {
  sqlite.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(id);
});

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

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
    "/api/conversations",
    async (req) => {
      const q = req.query.q?.trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? "", 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset ?? "", 10) || 0, 0);

      // Matches conversations by title, or that contain at least one matching message.
      const pattern = q ? `%${escapeLikeInput(q)}%` : undefined;
      const where = pattern
        ? or(
            likePattern(schema.conversations.title, pattern),
            inArray(
              schema.conversations.id,
              db
                .select({ id: schema.messages.conversationId })
                .from(schema.messages)
                .where(likePattern(schema.messages.content, pattern)),
            ),
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
    },
  );

  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const title = req.body?.title?.trim();
      if (!title) {
        return reply.code(400).send({ error: "title is required" });
      }
      const [existing] = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, req.params.id));
      if (!existing) {
        return reply.code(404).send({ error: "not found" });
      }
      await db
        .update(schema.conversations)
        .set({ title })
        .where(eq(schema.conversations.id, req.params.id));
      emitServerEvent("conversations");
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
    const [existing] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, req.params.id));
    if (!existing) {
      return reply.code(404).send({ error: "not found" });
    }
    // A turn currently running for this conversation can still insert its
    // assistant row (turnRecorder.ts's recordOutcome) after the delete below —
    // refuse instead of racing it, same 409 shape POST /api/chat itself
    // returns for a second concurrent send. runningConversations is added
    // synchronously right after beginTurn acquires the real in-flight guard,
    // with no `await` between the two, so this check can't miss a turn that
    // only just started.
    if (runningConversations.has(req.params.id)) {
      return reply.code(409).send({ error: "a reply is in progress for this conversation" });
    }
    // Drop the live agent session before deleting rows, not after: once this
    // resolves, nothing can start a new turn against this conversationId (the
    // next getOrCreateSession would rebuild from `messages`, which is about
    // to be gone), so no write can land after the delete below commits.
    await disposeSession(req.params.id);
    deleteConversation(req.params.id);
    emitServerEvent("conversations");
    return { ok: true };
  });

  app.get("/api/chat/system-prompt", async () => ({ prompt: await buildSystemPrompt() }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, req.params.id))
      .orderBy(schema.messages.createdAt);

    // The cards column is a JSON blob internally; the API ships parsed cards.
    let msgs = rows.map(({ cards, toolCalls, ...row }) => ({
      ...row,
      cards: parseStoredCards(cards),
      toolCalls: parseToolCalls(toolCalls),
    }));

    if (msgs.length === 0) {
      // Legacy-only fallback: automation runs now write real rows into
      // `messages` (see automations/scheduler.ts), so this only reconstructs
      // synthetic messages for runs that predate that change.
      const runs = await db
        .select()
        .from(schema.automationRuns)
        .where(eq(schema.automationRuns.id, req.params.id))
        .limit(1);

      if (runs.length > 0) {
        const run = runs[0];
        if (run) {
          const autos = await db
            .select()
            .from(schema.automations)
            .where(eq(schema.automations.id, run.automationId))
            .limit(1);
          const auto = autos[0];

          if (auto) {
            msgs = [
              {
                id: req.params.id + "-user",
                conversationId: req.params.id,
                role: "user",
                content: `Scheduled automation "${auto.name}". Execute this instruction now and report the outcome:\n\n${auto.instruction}`,
                createdAt: run.startedAt,
                cards: undefined,
                toolCalls: undefined,
                error: null,
              },
              {
                id: req.params.id + "-assistant",
                conversationId: req.params.id,
                role: "assistant",
                content: run.result || "Run failed or no result.",
                createdAt: run.finishedAt || run.startedAt,
                cards: undefined,
                toolCalls: undefined,
                error: null,
              },
            ];
          }
        }
      }
    }

    return msgs;
  });

  app.post<{ Body: ChatBody }>("/api/chat", async (req, reply) => {
    const message = req.body?.message?.trim();
    if (!message) {
      return reply.code(400).send({ error: "message is required" });
    }

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
        return reply
          .code(409)
          .send({ error: "a reply is already in progress for this conversation" });
      }
      throw error;
    }

    // We stream on the raw socket; tell Fastify the reply is ours now.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Stop the turn as soon as the client disconnects, so an abandoned tab
    // doesn't keep burning tool calls and model tokens (see routes/events.ts
    // for the same pattern on the plain SSE stream). Disconnect is signalled
    // by the *response* closing before we ended it — the request's own
    // "close" fires as soon as its body is consumed (Node ≥ 16), long before
    // the client goes away.
    let clientClosed = false;
    const controller = new AbortController();
    const onClientClose = () => {
      if (reply.raw.writableEnded) return;
      clientClosed = true;
      controller.abort();
    };
    reply.raw.on("close", onClientClose);

    const send = (event: ChatStreamEvent) => {
      if (clientClosed) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const now = () => new Date().toISOString();

    let streamedText = "";
    try {
      runningConversations.add(conversationId);
      emitServerEvent("conversations");

      // Create the conversation row on first use. This fires for every
      // freshly minted id, but a client-supplied id can also name a
      // conversation this server never recorded (e.g. stale client state
      // after a delete) — either way, the message rows this turn is about to
      // write must not end up orphaned against a nonexistent conversation.
      // No other route creates type: "chat" rows (automations/scheduler.ts
      // creates its own type: "automation" rows, keyed to the run id), so
      // this is the one place chat conversations come into being;
      // onConflictDoNothing makes the insert safe to attempt even when the
      // row already exists.
      const created = await db
        .insert(schema.conversations)
        .values({ id: conversationId, title: message.slice(0, 80), createdAt: now() })
        .onConflictDoNothing({ target: schema.conversations.id });
      if (created.changes > 0) {
        emitServerEvent("conversations");
      }
      send({ type: "conversation", conversationId });

      let thinkingSent = false;
      const { text } = await turn.run({
        prompt: message,
        session: "pooled",
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
          onToolStart: (toolCallId, toolName, parameters) => {
            send({
              type: "tool_start",
              toolCallId,
              toolName,
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
      // after writing the cancelled row); clientClosed already suppressed
      // send() by then. The transcript is already closed out one way or
      // another by turn.run() itself — this is only about telling a
      // still-connected client that something went wrong.
      req.log.error(error, "chat failed");
      send({ type: "error", message: errorMessage(error) });
    } finally {
      runningConversations.delete(conversationId);
      emitServerEvent("conversations");
      reply.raw.off("close", onClientClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
