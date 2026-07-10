import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../../src/agent/emailAgent.js";
import type { RunHandlers, TurnLogger } from "../../src/agent/run.js";
import type { TurnSessions } from "../../src/agent/turnRecorder.js";

// db/index.ts runs its DDL as an import-time side effect (see
// apps/server/src/db/index.ts) and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — so the only way to give this
// suite its own empty schema is to point DATABASE_PATH at a fresh temp file
// *before* anything pulls db/index.ts in, then import everything dynamically.
// A static `import ... from "../../src/agent/turnRecorder.js"` would already
// have evaluated db/index.ts (import bodies run before this file's own top-
// level code, regardless of where the import statement sits on the page).
const tempDir = mkdtempSync(join(tmpdir(), "trailin-turn-recorder-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { db, schema, sqlite } = await import("../../src/db/index.js");
const { beginTurn, TurnInFlightError, recoverInterruptedTurns, _setSessionsForTest } = await import(
  "../../src/agent/turnRecorder.js"
);
// runPrompt itself is pure — it only touches session.agent (a scriptable
// fake below) and the handlers it's given, never modelRegistry or Pipedream —
// so it's safe to use for real here, the same way emailAgent.ts's
// createAgentSession wraps it into runTurn for the real sessions.
const { runPrompt } = await import("../../src/agent/run.js");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

afterEach(() => {
  _setSessionsForTest(null);
});

const testLog: TurnLogger = { info: () => {}, warn: () => {} };

async function messagesFor(conversationId: string) {
  return db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(schema.messages.createdAt);
}

/**
 * Stands in for pi's real Agent class, exposing exactly what run.ts consumes
 * (subscribe/abort/prompt/state.errorMessage) and nothing else — the real
 * Agent builds against the modelRegistry singleton and can't run in tests.
 * Scriptable: emit(...) replays an AgentEvent to every subscriber, and
 * resolveTurn()/rejectTurn() settle the pending prompt() call, standing in
 * for the moment pi's Agent finishes (or aborts) a turn.
 */
class FakeAgent {
  state: { errorMessage?: string } = {};
  aborted = false;
  prompts: string[] = [];

  private listeners: Array<(event: unknown) => void> = [];
  private settle: { resolve: (text: void) => void; reject: (error: unknown) => void } | null = null;
  private promptedResolve!: () => void;

  /**
   * Resolves once prompt() has actually been called and its resolvers are
   * live — NOT merely once subscribe() has run. runPrompt (run.ts) calls
   * maybeCompact (an async, awaited step) between subscribe() and
   * agent.prompt(), so a test that resolves/rejects the turn right after
   * subscribe() would race that gap and call resolveTurn()/rejectTurn()
   * before `settle` exists, silently losing the signal forever.
   */
  whenPrompted: Promise<void> = new Promise((resolve) => {
    this.promptedResolve = resolve;
  });

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  abort(): void {
    this.aborted = true;
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.promptedResolve();
    });
  }

  resolveTurn(): void {
    this.settle?.resolve();
  }

  rejectTurn(error: unknown): void {
    this.settle?.reject(error);
  }
}

/** A fake AgentSession wired the same way emailAgent.ts's createAgentSession wires a real one. */
function fakeSession(agent: FakeAgent, closeSpy = vi.fn().mockResolvedValue(undefined)): AgentSession {
  const session: AgentSession = {
    agent: agent as unknown as Agent,
    toolset: { tools: [], readTools: [], close: closeSpy },
    inFlight: 0,
    lastUsed: Date.now(),
    async runTurn(prompt: string, handlers?: RunHandlers, signal?: AbortSignal, log?: TurnLogger) {
      session.inFlight++;
      try {
        return await runPrompt(session, prompt, handlers, signal, log);
      } finally {
        session.inFlight--;
        session.lastUsed = Date.now();
      }
    },
  };
  return session;
}

function toolResultEvent(toolCallId: string, details: unknown) {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "find-email",
    isError: false,
    result: { content: [], details },
  };
}

function neverEphemeral(): Promise<AgentSession> {
  return Promise.reject(new Error("ephemeral session not expected in this test"));
}

function neverPooled(): Promise<AgentSession> {
  return Promise.reject(new Error("pooled session not expected in this test"));
}

describe("turnRecorder", () => {
  it("writes the user row then the assistant row in order, with cards, and releases the guard", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const sessions: TurnSessions = {
      pooled: async () => fakeSession(agent, closeSpy),
      ephemeral: neverEphemeral,
    };
    _setSessionsForTest(sessions);

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({ prompt: "hello", session: "pooled", log: testLog });

    await agent.whenPrompted;
    agent.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi there" } });
    agent.emit(toolResultEvent("call-1", { kind: "email_hits", hits: [] }));
    agent.resolveTurn();

    const result = await runPromise;
    expect(result.text).toBe("hi there");
    expect(result.cards).toHaveLength(1);

    const rows = await messagesFor(conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.role).toBe("user");
    expect(rows[0]?.content).toBe("hello");
    expect(rows[1]?.role).toBe("assistant");
    expect(rows[1]?.content).toBe("hi there");
    expect(JSON.parse(rows[1]?.cards ?? "[]")).toHaveLength(1);

    // Pooled sessions are never closed by the recorder — that's the LRU/idle sweep's job.
    expect(closeSpy).not.toHaveBeenCalled();

    // Guard released: a second beginTurn for the same conversation now succeeds.
    expect(() => beginTurn(conversationId)).not.toThrow();
  });

  it("throws TurnInFlightError for an overlapping beginTurn, then succeeds once the run ends", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    _setSessionsForTest({ pooled: async () => fakeSession(agent), ephemeral: neverEphemeral });

    const turn = beginTurn(conversationId);
    expect(() => beginTurn(conversationId)).toThrow(TurnInFlightError);

    const runPromise = turn.run({ prompt: "hi", session: "pooled", log: testLog });
    await agent.whenPrompted;
    expect(() => beginTurn(conversationId)).toThrow(TurnInFlightError);

    agent.resolveTurn();
    await runPromise;

    expect(() => beginTurn(conversationId)).not.toThrow();
  });

  it("records a failed turn and rethrows the original error", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    _setSessionsForTest({ pooled: async () => fakeSession(agent), ephemeral: neverEphemeral });

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({ prompt: "hi", session: "pooled", log: testLog });
    await agent.whenPrompted;

    const boom = new Error("model exploded");
    agent.rejectTurn(boom);

    await expect(runPromise).rejects.toThrow("model exploded");

    const rows = await messagesFor(conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.role).toBe("assistant");
    expect(rows[1]?.content).toMatch(/^This turn failed:/);
    expect(rows[1]?.content).toContain("model exploded");

    expect(() => beginTurn(conversationId)).not.toThrow();
  });

  it("records a cancelled turn when the agent throws after the signal aborts, keeping cards collected so far", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    _setSessionsForTest({ pooled: async () => fakeSession(agent), ephemeral: neverEphemeral });
    const controller = new AbortController();

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({
      prompt: "hi",
      session: "pooled",
      signal: controller.signal,
      log: testLog,
    });
    await agent.whenPrompted;

    agent.emit(toolResultEvent("call-1", { kind: "email_hits", hits: [] }));
    controller.abort();
    agent.rejectTurn(new Error("aborted"));

    await expect(runPromise).rejects.toThrow();

    const rows = await messagesFor(conversationId);
    expect(rows[1]?.content).toBe("This reply was cancelled before it finished.");
    expect(JSON.parse(rows[1]?.cards ?? "[]")).toHaveLength(1);
  });

  it("records a cancelled turn when the signal is already aborted at resolution, even though the agent resolved cleanly", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    _setSessionsForTest({ pooled: async () => fakeSession(agent), ephemeral: neverEphemeral });
    const controller = new AbortController();

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({
      prompt: "hi",
      session: "pooled",
      signal: controller.signal,
      log: testLog,
    });
    await agent.whenPrompted;

    controller.abort();
    agent.resolveTurn(); // the agent "finishes" a beat too late, after the caller already gave up

    await expect(runPromise).rejects.toThrow();

    const rows = await messagesFor(conversationId);
    expect(rows[1]?.content).toBe("This reply was cancelled before it finished.");
  });

  it("closes the ephemeral session's toolset exactly once", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    _setSessionsForTest({
      pooled: neverPooled,
      ephemeral: async () => fakeSession(agent, closeSpy),
    });

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({ prompt: "hi", session: "ephemeral", log: testLog });
    await agent.whenPrompted;
    agent.resolveTurn();
    await runPromise;

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not close a pooled session's toolset", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    _setSessionsForTest({
      pooled: async () => fakeSession(agent, closeSpy),
      ephemeral: neverEphemeral,
    });

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({ prompt: "hi", session: "pooled", log: testLog });
    await agent.whenPrompted;
    agent.resolveTurn();
    await runPromise;

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("releases the guard and writes no user row when session acquisition fails", async () => {
    const conversationId = randomUUID();
    _setSessionsForTest({
      pooled: () => Promise.reject(new Error("pooled session unavailable")),
      ephemeral: neverEphemeral,
    });

    const turn = beginTurn(conversationId);
    await expect(turn.run({ prompt: "hi", session: "pooled", log: testLog })).rejects.toThrow(
      "pooled session unavailable",
    );

    const rows = await messagesFor(conversationId);
    expect(rows).toHaveLength(0);
    expect(() => beginTurn(conversationId)).not.toThrow();
  });

  it("caps only a stranded chat conversation with the restart marker, not an automation run", async () => {
    const chatId = randomUUID();
    const autoId = randomUUID();
    const now = new Date().toISOString();

    await db.insert(schema.conversations).values([
      { id: chatId, title: "chat", type: "chat", createdAt: now },
      { id: autoId, title: "run", type: "automation", createdAt: now },
    ]);
    await db.insert(schema.messages).values([
      { id: randomUUID(), conversationId: chatId, role: "user", content: "hi", createdAt: now },
      { id: randomUUID(), conversationId: autoId, role: "user", content: "run it", createdAt: now },
    ]);

    await recoverInterruptedTurns();

    const chatRows = await messagesFor(chatId);
    const autoRows = await messagesFor(autoId);

    expect(chatRows).toHaveLength(2);
    expect(chatRows[1]?.role).toBe("assistant");
    expect(chatRows[1]?.content).toContain("interrupted by a server restart");

    // type='automation' is out of scope for chat recovery — the scheduler's
    // own boot-time orphan sweep (automations/scheduler.ts) covers those.
    expect(autoRows).toHaveLength(1);
  });

  it("keeps only the later card when two cards share a toolCallId, while still streaming both to the caller", async () => {
    const conversationId = randomUUID();
    const agent = new FakeAgent();
    _setSessionsForTest({ pooled: async () => fakeSession(agent), ephemeral: neverEphemeral });
    const onCard = vi.fn();

    const turn = beginTurn(conversationId);
    const runPromise = turn.run({
      prompt: "hi",
      session: "pooled",
      handlers: { onCard },
      log: testLog,
    });
    await agent.whenPrompted;

    agent.emit(toolResultEvent("call-1", { kind: "email_hits", hits: [], query: "first" }));
    agent.emit(toolResultEvent("call-1", { kind: "email_hits", hits: [], query: "second" }));
    agent.resolveTurn();

    const result = await runPromise;

    // The caller's own handler sees every card as it streams by...
    expect(onCard).toHaveBeenCalledTimes(2);
    // ...but the persisted/returned set collapses a retried tool call to its latest card.
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0]?.card as { query?: string }).query).toBe("second");

    const rows = await messagesFor(conversationId);
    const persistedCards = JSON.parse(rows[1]?.cards ?? "[]") as Array<{ card: { query?: string } }>;
    expect(persistedCards).toHaveLength(1);
    expect(persistedCards[0]?.card.query).toBe("second");
  });
});
