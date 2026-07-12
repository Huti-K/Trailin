import type { ConnectedAccount } from "@trailin/shared";
import { describe, expect, it, vi } from "vitest";

const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

// outlookSyncProvider drives every fetch through proxyRequest — stub it the
// same way test/email/gmail/sync.test.ts stubs Gmail's equivalent, instead
// of hitting Pipedream's proxy for real.
const proxyRequestMock =
  vi.fn<
    (
      accountId: string,
      method: string,
      url: string,
      opts?: { params?: Record<string, string> },
    ) => Promise<unknown>
  >();
vi.mock("../../../src/pipedream/connect.js", () => ({
  proxyRequest: (...args: Parameters<typeof proxyRequestMock>) => proxyRequestMock(...args),
}));

const { outlookSyncProvider } = await import("../../../src/email/outlook/sync.js");

function account(id: string): ConnectedAccount {
  return {
    id,
    app: "microsoft_outlook",
    appName: "Outlook",
    name: id,
    healthy: true,
    createdAt: "2026-01-01",
  };
}

describe("outlookSyncProvider.fetchMessageHeaders", () => {
  it("selects internetMessageHeaders and extracts List-Unsubscribe + presence-based Post flag", async () => {
    proxyRequestMock.mockResolvedValueOnce({
      internetMessageHeaders: [
        { name: "Subject", value: "Newsletter" },
        {
          name: "List-Unsubscribe",
          value: "<mailto:unsub@example.com>, <https://example.com/unsub>",
        },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    });

    const result = await outlookSyncProvider.fetchMessageHeaders?.(account("acct-1"), "msg-1");

    expect(proxyRequestMock).toHaveBeenCalledWith("acct-1", "get", `${GRAPH_API}/messages/msg-1`, {
      params: { $select: "internetMessageHeaders" },
    });
    expect(result).toEqual({
      listUnsubscribe: "<mailto:unsub@example.com>, <https://example.com/unsub>",
      listUnsubscribePost: true,
    });
  });

  it("reports listUnsubscribePost false when the Post header is absent", async () => {
    proxyRequestMock.mockResolvedValueOnce({
      internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<https://example.com/unsub>" }],
    });

    const result = await outlookSyncProvider.fetchMessageHeaders?.(account("acct-1"), "msg-2");
    expect(result).toEqual({
      listUnsubscribe: "<https://example.com/unsub>",
      listUnsubscribePost: false,
    });
  });

  it("is case-insensitive matching header names", async () => {
    proxyRequestMock.mockResolvedValueOnce({
      internetMessageHeaders: [
        { name: "list-unsubscribe", value: "<https://example.com/unsub>" },
        { name: "LIST-UNSUBSCRIBE-POST", value: "List-Unsubscribe=One-Click" },
      ],
    });

    const result = await outlookSyncProvider.fetchMessageHeaders?.(account("acct-1"), "msg-3");
    expect(result).toEqual({
      listUnsubscribe: "<https://example.com/unsub>",
      listUnsubscribePost: true,
    });
  });

  it("returns an empty object when there is no List-Unsubscribe header at all", async () => {
    proxyRequestMock.mockResolvedValueOnce({
      internetMessageHeaders: [{ name: "Subject", value: "Plain message" }],
    });

    const result = await outlookSyncProvider.fetchMessageHeaders?.(account("acct-1"), "msg-4");
    expect(result).toEqual({});
  });

  it("returns an empty object when internetMessageHeaders itself is missing", async () => {
    proxyRequestMock.mockResolvedValueOnce({});
    const result = await outlookSyncProvider.fetchMessageHeaders?.(account("acct-1"), "msg-5");
    expect(result).toEqual({});
  });
});
