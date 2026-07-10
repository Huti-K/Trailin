import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentCard } from "@trailin/shared";
import { moduleLogger } from "../logger.js";
import { parseAgentCard } from "./cards.js";

/**
 * The slice of pino's Logger a turn needs. Spelling out the narrow shape lets
 * a route hand over `req.log.child(...)` — which Fastify types as
 * FastifyBaseLogger, not pino.Logger — without a cast.
 */
export interface TurnLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface RunHandlers {
  onTextDelta?: (delta: string) => void;
  onThinking?: () => void;
  onToolStart?: (toolCallId: string, toolName: string) => void;
  /** Progress text a long-running tool streamed via its onUpdate callback (e.g. delegate's "2/5 tasks done"). */
  onToolUpdate?: (toolCallId: string, toolName: string, detail: string) => void;
  onToolEnd?: (toolCallId: string, toolName: string, isError: boolean) => void;
  /** Fired for a tool_execution_end whose result carries a recognizable AgentCard, before onToolEnd. */
  onCard?: (toolCallId: string, card: AgentCard) => void;
}

const defaultLog = moduleLogger("agent");

/**
 * Run one prompt through the agent, forwarding streaming events to the
 * handlers. Resolves with the assistant's final text for this turn.
 *
 * `signal`, when given, aborts the in-flight run (streaming and any pending
 * tool calls) if it fires mid-turn — e.g. the HTTP client disconnecting.
 *
 * `log` should carry whatever identifies this turn (a conversation id, an
 * automation run id) so its tool calls can be picked out of the stream.
 */
export async function runPrompt(
  session: { agent: Agent },
  prompt: string,
  handlers: RunHandlers = {},
  signal?: AbortSignal,
  log: TurnLogger = defaultLog,
): Promise<string> {
  // Already gone before we started — don't open a turn at all.
  if (signal?.aborted) return "";

  let text = "";
  const turnStartedAt = Date.now();
  // toolCallId -> start time, so tool_execution_end can report a duration.
  const toolStarts = new Map<string, number>();
  let toolCalls = 0;
  let toolErrors = 0;

  const unsubscribe = session.agent.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        // Forward only visible text; thinking deltas keep their own type.
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          text += inner.delta;
          handlers.onTextDelta?.(inner.delta);
        } else if (inner.type === "thinking_delta") {
          handlers.onThinking?.();
        }
        break;
      }
      case "tool_execution_start": {
        toolStarts.set(event.toolCallId, Date.now());
        handlers.onToolStart?.(event.toolCallId, event.toolName);
        break;
      }
      case "tool_execution_update": {
        // partialResult is a tool's streamed AgentToolResult, typed `any` by
        // pi — extract the first text block defensively.
        const partial = event.partialResult as { content?: unknown } | undefined;
        const blocks = Array.isArray(partial?.content) ? partial.content : [];
        const first = blocks[0] as { type?: string; text?: unknown } | undefined;
        if (first?.type === "text" && typeof first.text === "string" && first.text) {
          handlers.onToolUpdate?.(event.toolCallId, event.toolName, first.text);
        }
        break;
      }
      case "tool_execution_end": {
        const { toolName, toolCallId, isError } = event;
        toolCalls += 1;
        if (isError) toolErrors += 1;

        const startedAt = toolStarts.get(toolCallId);
        toolStarts.delete(toolCallId);

        // A tool's arguments and its result are the user's mail. Only the
        // tool's name, outcome and timing are ever written to the log.
        const fields = { tool: toolName, ms: startedAt === undefined ? undefined : Date.now() - startedAt };
        if (isError) log.warn(fields, "tool call failed");
        else log.info(fields, "tool call");

        // event.result is the tool's raw { content, details } return, typed
        // `any` by pi — details may be malformed or absent, parseAgentCard
        // never throws.
        const result = event.result as { details?: unknown } | undefined;
        const card = parseAgentCard(result?.details);
        if (card) handlers.onCard?.(toolCallId, card);
        handlers.onToolEnd?.(toolCallId, toolName, isError);
        break;
      }
    }
  });

  // The pi Agent owns its own AbortController per run; forward the external
  // signal into it so the model stream and tool execution actually stop.
  const onAbort = () => session.agent.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    await session.agent.prompt(prompt);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (typeof unsubscribe === "function") unsubscribe();
  }

  const durationMs = Date.now() - turnStartedAt;

  // pi doesn't throw on provider failures (missing credentials, refused
  // requests); it records them on the state. Surface them to the caller.
  const failure = session.agent.state.errorMessage;
  if (failure) {
    log.warn({ durationMs, toolCalls, toolErrors, failure }, "agent turn failed");
    throw new Error(failure);
  }

  log.info({ durationMs, toolCalls, toolErrors }, "agent turn finished");
  return text.trim();
}
