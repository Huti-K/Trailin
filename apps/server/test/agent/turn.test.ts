import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The agent turn driven through its public seam: a scripted fake session
 * stands in for the model, everything else (prompt assembly, activity
 * collection, persistence, the in-flight guard, history rebuild) is real code
 * against a real scratch database.
 */

/** Imported dynamically after DATABASE_PATH points at a scratch file; env.ts reads it at import. */
let turnRecorder: typeof import("../../src/agent/turnRecorder.js");
let dbModule: typeof import("../../src/db/index.js");
type AgentSession = import("../../src/agent/sessionCache.js").AgentSession;

const silentLog = { info: () => {}, warn: () => {} };

function fakeSession(runTurn: AgentSession["runTurn"], onClose?: () => void): AgentSession {
  return {
    agent: null as never,
    toolset: {
      tools: [],
      readTools: [],
      close: async () => {
        onClose?.();
      },
    },
    inFlight: 0,
    lastUsed: Date.now(),
    runTurn,
  };
}

const unusedSessions = {
  pooled: async (): Promise<AgentSession> => {
    throw new Error("pooled session not expected in this test");
  },
  ephemeral: async (): Promise<AgentSession> => {
    throw new Error("ephemeral session not expected in this test");
  },
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "trailin-turn-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  turnRecorder = await import("../../src/agent/turnRecorder.js");
  dbModule = await import("../../src/db/index.js");
});

afterAll(() => {
  turnRecorder._setSessionsForTest(null);
});

describe("an agent turn", () => {
  it("persists a completed turn: conversation, raw user row, assistant row with cards and tool activity", async () => {
    const card = {
      kind: "email_draft",
      account: { accountId: "acc-1", name: "kadim@example.com", app: "gmail", appName: "Gmail" },
      draft: {
        draftId: "d-1",
        subject: "Re: Besichtigung",
        to: ["anna@example.com"],
        body: "Gerne, passt Donnerstag?",
      },
    } as AgentCard;

    turnRecorder._setSessionsForTest({
      ...unusedSessions,
      pooled: async () =>
        fakeSession(async (prompt, handlers) => {
          // The prompt that reaches the model is the decorated turn prompt:
          // raw text still present, plus the bracketed per-turn notes.
          expect(prompt).toContain("draft me a reply to Anna");
          expect(prompt).toContain("[Current date and time:");
          handlers?.onToolStart?.("call-1", "create_draft", "Create email draft", {
            to: ["anna@example.com"],
          });
          handlers?.onCard?.("call-1", card);
          handlers?.onToolEnd?.("call-1", "create_draft", false, {
            content: [{ type: "text", text: "Draft created (draft id d-1)." }],
          });
          return "Done — the draft is ready.";
        }),
    });

    const turn = turnRecorder.beginTurn("conv-1");
    const { text, cards } = await turn.run({
      prompt: "draft me a reply to Anna",
      session: "pooled",
      conversation: { type: "chat", title: "draft me a reply to Anna" },
      log: silentLog,
    });

    expect(text).toBe("Done — the draft is ready.");
    expect(cards).toEqual([{ toolCallId: "call-1", card }]);

    const { db, schema } = dbModule;
    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, "conv-1"));
    expect(conversation?.type).toBe("chat");
    expect(conversation?.title).toBe("draft me a reply to Anna");

    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, "conv-1"));
    const user = rows.find((row) => row.role === "user");
    const assistant = rows.find((row) => row.role === "assistant");
    // The persisted user row keeps the RAW prompt; decoration is model-only.
    expect(user?.content).toBe("draft me a reply to Anna");
    expect(assistant?.content).toBe("Done — the draft is ready.");
    expect(JSON.parse(assistant?.cards ?? "[]")).toEqual([{ toolCallId: "call-1", card }]);
    // The turn's tool activity persists with the row: the UI's activity view
    // and the model-history rebuild both read it.
    expect(JSON.parse(assistant?.toolCalls ?? "[]")).toMatchObject([
      {
        id: "call-1",
        name: "create_draft",
        done: true,
        isError: false,
        parameters: { to: ["anna@example.com"] },
      },
    ]);
  });

  it("rebuilds the model transcript with tool activity and replays compaction", async () => {
    const { db, schema } = dbModule;
    const conversationId = "conv-rebuild";
    const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString();
    await db.insert(schema.messages).values([
      { id: "m1", conversationId, role: "user", content: "find the invoice", createdAt: at(0) },
      {
        id: "m2",
        conversationId,
        role: "assistant",
        content: "Found it.",
        toolCalls: JSON.stringify([
          {
            id: "t1",
            name: "search_email",
            isError: false,
            done: true,
            parameters: { q: "invoice" },
            result: { content: [{ type: "text", text: "1 thread found." }] },
          },
        ]),
        createdAt: at(1000),
      },
    ]);

    const history = await import("../../src/agent/history.js");
    const first = await history.loadHistory(conversationId);
    expect(first.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(first[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "search_email" }],
    });
    expect(first[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "1 thread found." }],
    });

    // A compaction row replays as the live session experienced it: the rows
    // its summary covers drop, the kept-verbatim tail stays in full.
    await db.insert(schema.messages).values([
      {
        id: "m3",
        conversationId,
        role: "compaction",
        content: "[Summary] The invoice was found.",
        compactionCutoff: Date.parse(at(1000)),
        createdAt: at(2000),
      },
      { id: "m4", conversationId, role: "user", content: "thanks", createdAt: at(3000) },
    ]);
    const rebuilt = await history.loadHistory(conversationId);
    expect(rebuilt[0]).toMatchObject({
      role: "user",
      content: "[Summary] The invoice was found.",
    });
    expect(rebuilt.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
  });

  it("refuses a second concurrent turn for the same conversation", async () => {
    turnRecorder._setSessionsForTest({
      ...unusedSessions,
      pooled: async () => fakeSession(async () => "ok"),
    });

    const turn = turnRecorder.beginTurn("conv-overlap");
    expect(() => turnRecorder.beginTurn("conv-overlap")).toThrow(turnRecorder.TurnInFlightError);

    // Completing the turn releases the guard for the conversation's next send.
    await turn.run({
      prompt: "hello",
      session: "pooled",
      conversation: { type: "chat", title: "hello" },
      log: silentLog,
    });
    turnRecorder.beginTurn("conv-overlap");
  });

  it("caps a failed ephemeral run with a failure row and closes its toolset", async () => {
    let closed = false;
    turnRecorder._setSessionsForTest({
      ...unusedSessions,
      ephemeral: async () =>
        fakeSession(
          async () => {
            throw new Error("model exploded");
          },
          () => {
            closed = true;
          },
        ),
    });

    const turn = turnRecorder.beginTurn("run-1");
    await expect(
      turn.run({
        prompt: "Scheduled automation …",
        session: "ephemeral",
        conversation: { type: "automation", title: "Run: Morning briefing" },
        log: silentLog,
      }),
    ).rejects.toThrow("model exploded");

    // An ephemeral session belongs to its run alone; the run must close it.
    expect(closed).toBe(true);

    const { db, schema } = dbModule;
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, "run-1"));
    const assistant = rows.find((row) => row.role === "assistant");
    expect(assistant?.content).toContain("This turn failed: model exploded");
  });
});
