import type { Agent } from "@earendil-works/pi-agent-core";
import { moduleLogger } from "../logger.js";
import { buildAgent } from "./assembly.js";
import { sessionCapabilities } from "./capabilities.js";
import { maybeCompact } from "./compaction.js";
import { type EmailToolset, loadEmailTools } from "./emailToolset.js";
import { loadHistory } from "./history.js";
import { buildSystemPrompt } from "./prompt.js";
import { type RunHandlers, runPrompt, type TurnLogger } from "./run.js";

/**
 * The agent sessions themselves: one pooled pi Agent per conversation (idle
 * TTL + LRU capped, swept on a timer) plus throwaway ephemeral sessions for
 * automation runs. Owns every session's lifecycle — creation, the busy
 * tracking that keeps the sweeper from closing a toolset mid-turn, and
 * disposal of the MCP connections a toolset holds.
 */

const log = moduleLogger("sessionCache");

export interface AgentSession {
  agent: Agent;
  toolset: EmailToolset;
  /**
   * Turns currently running against this session. sweepSessions (below) must
   * never close a session's toolset while this is above zero — go through
   * runTurn (not the bare runPrompt) so a turn can't forget to mark itself.
   */
  inFlight: number;
  /** Idle/LRU eviction clock: refreshed on creation, on lookup, and when a turn ends. */
  lastUsed: number;
  /**
   * Runs one prompt through this session, exactly like the standalone
   * runPrompt, but also marks the session busy for the turn's duration and
   * refreshes lastUsed when it ends — see sweepSessions.
   */
  runTurn(
    prompt: string,
    handlers?: RunHandlers,
    signal?: AbortSignal,
    log?: TurnLogger,
  ): Promise<string>;
}

/** Wraps a fresh agent/toolset pair with the busy-tracking runTurn every cached session shares. */
function createAgentSession(agent: Agent, toolset: EmailToolset): AgentSession {
  const session: AgentSession = {
    agent,
    toolset,
    inFlight: 0,
    lastUsed: Date.now(),
    async runTurn(prompt, handlers, signal, log) {
      session.inFlight++;
      try {
        return await runPrompt(session, prompt, {
          handlers,
          signal,
          log,
          compact: (options) => maybeCompact(session.agent, log, options),
        });
      } finally {
        session.inFlight--;
        session.lastUsed = Date.now();
      }
    },
  };
  return session;
}

// Idle sessions keep their MCP connections open for nothing; cap both how
// long one can sit unused and how many can exist at once.
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX_COUNT = 20;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, AgentSession>();
// In-flight session creations, keyed by conversationId — lets two concurrent
// requests for a brand-new conversation share one creation instead of each
// opening (and one of them leaking) its own MCP session.
const pendingSessions = new Map<string, Promise<AgentSession>>();

/** Same disposal path resetSessions()/disposeSession() use, for idle/LRU eviction too. */
function evictSession(conversationId: string, session: AgentSession): void {
  sessions.delete(conversationId);
  void session.toolset.close().catch((err: unknown) => {
    log.warn({ err, conversationId }, "closing an evicted session's MCP sessions failed");
  });
}

function sweepSessions(): void {
  const now = Date.now();
  for (const [conversationId, session] of sessions) {
    // A turn is running against this session; closing its toolset now would
    // pull the rug out from under an in-flight tool call.
    if (session.inFlight > 0) continue;
    if (now - session.lastUsed > SESSION_IDLE_TTL_MS) evictSession(conversationId, session);
  }
  if (sessions.size > SESSION_MAX_COUNT) {
    const evictable = [...sessions.entries()]
      .filter(([, session]) => session.inFlight === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [conversationId, session] of evictable.slice(0, sessions.size - SESSION_MAX_COUNT)) {
      evictSession(conversationId, session);
    }
  }
}

const sweepTimer = setInterval(sweepSessions, SESSION_SWEEP_INTERVAL_MS);
sweepTimer.unref();

/** One pi Agent per conversation; context lives in process memory. */
export async function getOrCreateSession(conversationId: string): Promise<AgentSession> {
  const existing = sessions.get(conversationId);
  if (existing) {
    existing.lastUsed = Date.now();
    // Memory/library/settings context can go stale on a long-lived session —
    // recompute the system prompt before every prompt. The rebuild is
    // byte-identical unless those inputs actually changed (buildSystemPrompt
    // holds no clock or per-request values), so the provider's cached prefix
    // survives every turn where nothing moved.
    existing.agent.state.systemPrompt = await buildSystemPrompt();
    return existing;
  }

  // Two concurrent requests for the same new conversationId must share one
  // creation — otherwise both pass the check above and each opens its own
  // MCP session, leaking whichever one loses the race to `sessions.set`.
  const inFlight = pendingSessions.get(conversationId);
  if (inFlight) return inFlight;

  const creation = (async (): Promise<AgentSession> => {
    const caps = await sessionCapabilities(true);
    const toolsetPromise = loadEmailTools({ providerWrites: caps.providerWrites });
    try {
      const [toolset, history] = await Promise.all([toolsetPromise, loadHistory(conversationId)]);
      const session = createAgentSession(
        await buildAgent(toolset, history, caps, conversationId),
        toolset,
      );
      sessions.set(conversationId, session);
      if (sessions.size > SESSION_MAX_COUNT) sweepSessions();
      return session;
    } catch (error) {
      // toolsetPromise may have resolved (live MCP connections open) even
      // though loadHistory or buildAgent failed — close it instead of
      // leaking those connections on every retry of a failing conversation.
      await toolsetPromise
        .then((t) => t.close())
        .catch((err: unknown) => {
          log.warn({ err, conversationId }, "closing the failed session's MCP sessions failed");
        });
      throw error;
    }
  })();
  pendingSessions.set(conversationId, creation);
  try {
    return await creation;
  } finally {
    pendingSessions.delete(conversationId);
  }
}

/** Drop all in-memory agent sessions (e.g. after auth or model changes). */
export async function resetSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    all.map((session) =>
      session.toolset.close().catch((err: unknown) => {
        log.warn({ err }, "closing a reset session's MCP sessions failed");
      }),
    ),
  );
}

export async function disposeSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId);
  if (!session) return;
  sessions.delete(conversationId);
  await session.toolset.close();
}

/**
 * Create a throwaway session (used by scheduled automations). No human
 * reviews a scheduled run's actions before they happen, so the unattended
 * profile withholds every provider write tool while leaving draft tools
 * untouched (providerWrites, see loadEmailTools).
 */
export async function createEphemeralSession(): Promise<AgentSession> {
  const caps = await sessionCapabilities(false);
  const toolset = await loadEmailTools({ providerWrites: caps.providerWrites });
  try {
    return createAgentSession(await buildAgent(toolset, [], caps), toolset);
  } catch (error) {
    // buildAgent failing (bad model config, a settings read failing) must not
    // leak the MCP connections loadEmailTools already opened — this runs on
    // every scheduled automation tick.
    await toolset.close().catch((err: unknown) => {
      log.warn({ err }, "closing the ephemeral session's MCP sessions failed");
    });
    throw error;
  }
}
