import type { AgentCard, ConnectedAccount } from "@trailin/shared";
import { describe, expect, it, vi } from "vitest";

// composeBriefingTool resolves the `account` param on each item the same way
// every other agent tool does — via listAccounts() — so it's stubbed the same
// way test/agent/choicesTool.test.ts stubs it, instead of hitting Pipedream.
const listAccountsMock = vi.fn<() => Promise<ConnectedAccount[]>>();
vi.mock("../../src/pipedream/connect.js", () => ({
  listAccounts: () => listAccountsMock(),
}));

const { composeBriefingTool } = await import("../../src/agent/briefingTool.js");

function account(id: string, app: string, name: string): ConnectedAccount {
  return { id, app, appName: app, name, healthy: true, createdAt: "2026-01-01" };
}

const gmailAccount = account("acc-gmail", "gmail", "work@example.com");
const outlookAccount = account("acc-outlook", "microsoft_outlook", "work@outlook.com");
const notionAccount = account("acc-notion", "notion", "Notion workspace");

const baseItem = {
  threadId: "t1",
  sender: "Ayşe Kaya",
  subject: "Contract renewal",
  gist: "Wants to renew before Friday.",
  priority: "urgent",
};

function callBriefing(params: unknown) {
  return composeBriefingTool.execute("call-1", params as never);
}

function cardOf(result: Awaited<ReturnType<typeof callBriefing>>): AgentCard | undefined {
  return result.details as AgentCard | undefined;
}

function textOf(result: Awaited<ReturnType<typeof callBriefing>>): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("compose_briefing — webUrl resolution", () => {
  it("builds a Gmail deep link from the item's threadId and resolved account", async () => {
    listAccountsMock.mockResolvedValue([gmailAccount]);
    const result = await callBriefing({
      items: [{ ...baseItem, account: "work@example.com" }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBe(
      "https://mail.google.com/mail/?authuser=work%40example.com#all/t1",
    );
  });

  it("builds the account-pinned Outlook web root when no per-thread deep link is known", async () => {
    listAccountsMock.mockResolvedValue([outlookAccount]);
    const result = await callBriefing({
      items: [{ ...baseItem, account: "work@outlook.com" }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBe(
      "https://outlook.live.com/mail/?login_hint=work%40outlook.com",
    );
  });

  it("omits webUrl for an app with no known web UI", async () => {
    listAccountsMock.mockResolvedValue([notionAccount]);
    const result = await callBriefing({
      items: [{ ...baseItem, account: "Notion workspace" }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBeUndefined();
  });

  it("omits webUrl when the item's account doesn't resolve to a connected account", async () => {
    listAccountsMock.mockResolvedValue([gmailAccount]);
    const result = await callBriefing({
      items: [{ ...baseItem, account: "nobody@example.com" }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBeUndefined();
    // The item itself still survives — a resolvable account is nice-to-have
    // for the deep link, not required for the item to be kept.
    expect(card.items[0]?.threadId).toBe("t1");
  });

  it("omits webUrl when the item carries no account at all", async () => {
    listAccountsMock.mockResolvedValue([gmailAccount]);
    const result = await callBriefing({ items: [{ ...baseItem }] });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBeUndefined();
  });

  it("never trusts a model-supplied webUrl on the raw item", async () => {
    listAccountsMock.mockResolvedValue([notionAccount]);
    const result = await callBriefing({
      items: [{ ...baseItem, account: "Notion workspace", webUrl: "https://evil.example" }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items[0]?.webUrl).toBeUndefined();
  });
});

describe("compose_briefing — item and rollup validation", () => {
  it("drops an item missing threadId and reports the drop in its text result", async () => {
    listAccountsMock.mockResolvedValue([]);
    const { threadId: _omit, ...rest } = baseItem;
    const result = await callBriefing({ items: [rest] });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items).toHaveLength(0);
    expect(textOf(result)).toContain("1 item dropped");
  });

  it("rolls up low-value mail with a resolved accountId, no webUrl field", async () => {
    listAccountsMock.mockResolvedValue([gmailAccount]);
    const result = await callBriefing({
      items: [],
      rollups: [{ account: "work@example.com", label: "Newsletters", count: 6 }],
    });
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.rollups).toEqual([{ accountId: "acc-gmail", label: "Newsletters", count: 6 }]);
  });

  it("publishes an empty briefing without throwing when no items are given", async () => {
    listAccountsMock.mockResolvedValue([]);
    const result = await callBriefing({ items: [] });
    expect(textOf(result)).toContain("no noteworthy items");
    const card = cardOf(result) as Extract<AgentCard, { kind: "briefing" }>;
    expect(card.items).toEqual([]);
  });
});
