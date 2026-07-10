import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { findCutIndex, KEEP_RECENT_TOKENS } from "../../src/agent/compaction.js";

// estimateTokens (pi-agent-core) is a plain chars/4 heuristic per role, so
// fixtures below use char counts that are multiples of 4 for exact,
// rounding-free token counts.

function userMessage(chars: number, timestamp: number): AgentMessage {
  return { role: "user", content: "x".repeat(chars), timestamp };
}

function assistantMessage(chars: number, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(chars) }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function toolResultMessage(chars: number, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "test-tool",
    content: [{ type: "text", text: "x".repeat(chars) }],
    isError: false,
    timestamp,
  };
}

describe("findCutIndex", () => {
  it("returns 0 for an empty transcript", () => {
    expect(findCutIndex([])).toBe(0);
  });

  it("returns 0 (nothing to compact) when the whole transcript fits within KEEP_RECENT_TOKENS", () => {
    const messages = [
      userMessage(40, 1),
      assistantMessage(40, 2),
      userMessage(40, 3),
      assistantMessage(40, 4),
    ];
    expect(findCutIndex(messages)).toBe(0);
  });

  it("steps the cut back one message when the raw token cut lands on a single toolResult", () => {
    // 19,995 recent tokens (message 3) + a 10-token toolResult (message 2)
    // crosses KEEP_RECENT_TOKENS (20,000) right after message 2 is folded
    // in, so the raw cut lands on that toolResult; the walk-back must move
    // it to the preceding assistant message that issued the tool call.
    const messages = [
      userMessage(40, 1), // dropped filler
      assistantMessage(40, 2), // issues the tool call
      toolResultMessage(40, 3),
      userMessage(79_980, 4), // recent: 19,995 tokens
    ];

    expect(findCutIndex(messages)).toBe(1);
    expect(messages[1]?.role).toBe("assistant");
  });

  it("walks the cut back over a whole run of toolResult messages so it never opens mid-tool-call", () => {
    // Same shape, but with three toolResults in a row — the raw cut lands on
    // the middle one, and the walk-back must skip all three, not just one.
    const messages = [
      userMessage(200, 1), // dropped filler
      userMessage(200, 2), // dropped filler
      assistantMessage(40, 3), // issues three tool calls
      toolResultMessage(40, 4),
      toolResultMessage(40, 5),
      toolResultMessage(40, 6),
      userMessage(79_980, 7), // recent: 19,995 tokens
    ];

    const cutIndex = findCutIndex(messages);

    expect(cutIndex).toBe(2);
    expect(messages[cutIndex]?.role).not.toBe("toolResult");
    // The whole tool-call batch stays together with the assistant turn that issued it.
    expect(messages.slice(cutIndex).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "user",
    ]);
    // And the dropped prefix never includes a bare toolResult either.
    expect(messages.slice(0, cutIndex).some((m) => m.role === "toolResult")).toBe(false);
  });

  it("keeps KEEP_RECENT_TOKENS as the trigger this test suite is pinned to", () => {
    // Guards against a silent threshold change invalidating the char counts above.
    expect(KEEP_RECENT_TOKENS).toBe(20_000);
  });
});
