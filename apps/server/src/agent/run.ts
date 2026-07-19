import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AgentCard } from "@trailin/shared";
import { moduleLogger, type TurnLogger } from "../core/logger.js";
import { parseAgentCard } from "./cards.js";

export interface RunHandlers {
  onTextDelta?: (delta: string) => void;
  onThinking?: () => void;
  onToolStart?: (
    toolCallId: string,
    toolName: string,
    toolLabel: string,
    parameters: unknown,
  ) => void;
  onToolUpdate?: (toolCallId: string, toolName: string, detail: string) => void;
  onToolEnd?: (toolCallId: string, toolName: string, isError: boolean, result: unknown) => void;
  onCard?: (toolCallId: string, card: AgentCard) => void;
}

export interface RunOptions {
  handlers?: RunHandlers;
  signal?: AbortSignal;
  log?: TurnLogger;
  /**
   * Trims the session's transcript when it nears the model's context window
   * (see compaction.ts); called again with `force` after a provider
   * context-overflow error, which shrinks the transcript so a retry is worth
   * attempting. Absent for one-shot agents, whose single prompt cannot outgrow
   * the window.
   */
  compact?: (options?: { force?: boolean }) => Promise<boolean>;
}

const defaultLog = moduleLogger("agent");

/** Turn-retry budget for transient provider failures (rate limits, 5xx, dropped streams). */
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

/** Provider context-overflow errors, which retry cleanly only after the transcript shrinks. */
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|maximum context length|context window|input token count exceeds/i;

/** True when the errored turn already streamed visible text; a retry would repeat it. */
function streamedVisibleText(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "text" && block.text.trim() !== "");
}

/** Abortable backoff: 2s then 6s, plus jitter, resolving early when the signal fires. */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = RETRY_BASE_DELAY_MS * 3 ** (attempt - 1) + Math.random() * 500;
  return new Promise((resolve) => {
    const timer = setTimeout(done, delay);
    function done(): void {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

/**
 * Retries a turn that ended in a transient provider failure with no
 * user-visible output. pi doesn't throw on provider errors: it appends the
 * errored assistant message and records state.errorMessage, so recovery is
 * classify the failure, drop the errored message, and continue() from the
 * user/toolResult tail. A context-overflow failure gets one forced compaction
 * first (the estimate was proven wrong, so the transcript shrinks);
 * everything else backs off briefly. Failures that already streamed visible
 * text, aborted turns, and non-transient errors surface unchanged.
 */
async function retryTransientFailures(
  agent: Agent,
  log: TurnLogger,
  signal?: AbortSignal,
  compact?: RunOptions["compact"],
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const failure = agent.state.errorMessage;
    if (!failure || signal?.aborted) return;
    const last = agent.state.messages[agent.state.messages.length - 1];
    if (last?.role !== "assistant") return;
    const errored = last as AssistantMessage;
    // "aborted" is the caller's own cancellation, never retried.
    if (errored.stopReason !== "error") return;
    if (streamedVisibleText(errored)) return;

    const overflow = CONTEXT_OVERFLOW_PATTERN.test(failure);
    if (!overflow && !isRetryableAssistantError(errored)) return;

    if (overflow) {
      // Compact before touching the transcript tail: when nothing can be
      // compacted, the errored message stays in place and the failure
      // surfaces as-is rather than retrying into the same overflow.
      if (!compact || !(await compact({ force: true }))) return;
    }

    // continue() resumes from a user/toolResult tail: drop the errored
    // assistant message it re-attempts.
    agent.state.messages = agent.state.messages.slice(0, -1);

    if (!overflow) {
      await backoff(attempt, signal);
      if (signal?.aborted) return;
    }
    log.warn({ attempt, failure }, "retrying turn after transient provider failure");
    await agent.continue();
  }
}

export async function runPrompt(
  session: { agent: Agent },
  prompt: string,
  options: RunOptions = {},
): Promise<string> {
  const { handlers = {}, signal, log = defaultLog, compact } = options;
  // Already aborted before we start; don't open a turn at all.
  if (signal?.aborted) return "";

  let text = "";
  const turnStartedAt = Date.now();
  // Tool name -> display label, resolved once: the toolset is fixed for the turn.
  const toolLabels = new Map(session.agent.state.tools.map((t) => [t.name, t.label]));
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
        handlers.onToolStart?.(
          event.toolCallId,
          event.toolName,
          toolLabels.get(event.toolName) ?? event.toolName,
          event.args,
        );
        break;
      }
      case "tool_execution_update": {
        // partialResult is a tool's streamed AgentToolResult, typed `any` by
        // pi; extract the first text block defensively.
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
        const fields = {
          tool: toolName,
          ms: startedAt === undefined ? undefined : Date.now() - startedAt,
        };
        if (isError) log.warn(fields, "tool call failed");
        else log.info(fields, "tool call");

        // event.result is the tool's raw { content, details } return, typed
        // `any` by pi; details may be malformed or absent, parseAgentCard
        // never throws.
        const result = event.result as { details?: unknown } | undefined;
        const card = parseAgentCard(result?.details);
        if (card) handlers.onCard?.(toolCallId, card);
        handlers.onToolEnd?.(toolCallId, toolName, isError, event.result);
        break;
      }
    }
  });

  // The pi Agent owns its own AbortController per run; forward the external
  // signal into it so the model stream and tool execution actually stop.
  const onAbort = () => session.agent.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    // Trim the transcript in advance if it's nearing the context window; fails
    // open (never throws), so a compaction hiccup can't sink the turn.
    await compact?.();
    await session.agent.prompt(prompt);
    // Transient provider failures are retried in place while the subscription
    // above is still attached, so a successful retry streams through the same
    // handlers.
    await retryTransientFailures(session.agent, log, signal, compact);
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
