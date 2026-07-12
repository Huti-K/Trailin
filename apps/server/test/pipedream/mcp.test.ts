import type { AccountDescription, ConnectedAccount } from "@trailin/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loadEmailTools opens one Pipedream MCP session per account that needs one
 * (pipedream/mcp.ts's connectForAccount: a StreamableHTTPClientTransport plus
 * an MCP Client). Fake both at the SDK boundary instead of a real HTTP
 * handshake — the fake client keys its listTools() response off the
 * x-pd-account-id header the real transport carries, so each connected
 * account gets its own fixed tool list no matter what order Promise.all
 * resolves the per-account connects in.
 */
const toolsByAccountId = new Map<
  string,
  { name: string; description?: string; inputSchema: { type: "object"; properties: object } }[]
>();
let connectCallCount = 0;
const closedAccountIds: string[] = [];

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  // A plain `function`, not an arrow: connectForAccount calls this with
  // `new`, and only a real function (or class) lets the returned object
  // override the constructed `this` the way vi.fn()'s own default doesn't.
  // biome-ignore lint/complexity/useArrowFunction: must stay a real function so `new` works (see above)
  StreamableHTTPClientTransport: vi.fn(function (
    _url: URL,
    opts: { requestInit?: { headers?: Record<string, string> } },
  ) {
    return { accountId: opts?.requestInit?.headers?.["x-pd-account-id"] ?? "" };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class FakeMcpClient {
    private accountId = "";
    async connect(transport: { accountId?: string }): Promise<void> {
      connectCallCount++;
      this.accountId = transport.accountId ?? "";
    }
    async listTools() {
      return { tools: toolsByAccountId.get(this.accountId) ?? [] };
    }
    async close(): Promise<void> {
      closedAccountIds.push(this.accountId);
    }
    async callTool() {
      return { content: [], isError: false };
    }
  }
  return { Client: FakeMcpClient };
});

// listAccounts/getConnectConfig/getPipedreamAccessToken are stubbed the same
// way test/agent/accounts.test.ts stubs them — spread the real module so the
// gmail/outlook draft and attachment providers pulled in transitively (they
// import proxyRequest from this module at the top level) still resolve.
const listAccountsMock = vi.fn<() => Promise<ConnectedAccount[]>>();
vi.mock("../../src/pipedream/connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pipedream/connect.js")>();
  return {
    ...actual,
    getConnectConfig: async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      projectId: "proj_test",
      environment: "development" as const,
      externalUserId: "user-1",
      source: "settings" as const,
    }),
    getPipedreamAccessToken: async () => "fake-token",
    listAccounts: () => listAccountsMock(),
  };
});

const writeAccessMock = vi.fn<() => Promise<string[]>>();
const descriptionsMock = vi.fn<() => Promise<AccountDescription[]>>();
vi.mock("../../src/db/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/settings.js")>();
  return {
    ...actual,
    getWriteAccessAccounts: () => writeAccessMock(),
    getAccountDescriptions: () => descriptionsMock(),
  };
});

const { loadEmailTools } = await import("../../src/pipedream/mcp.js");

function account(id: string, app: string, name: string): ConnectedAccount {
  return { id, app, appName: app, name, healthy: true, createdAt: "2026-01-01" };
}

function tool(name: string) {
  return { name, description: name, inputSchema: { type: "object" as const, properties: {} } };
}

beforeEach(() => {
  toolsByAccountId.clear();
  closedAccountIds.length = 0;
  connectCallCount = 0;
  listAccountsMock.mockReset();
  writeAccessMock.mockReset();
  descriptionsMock.mockReset();
  descriptionsMock.mockResolvedValue([]);
});

describe("loadEmailTools — providerWrites gating", () => {
  it("registers write tools for a write-armed account by default (providerWrites unset)", async () => {
    const acc = account("acc-slack", "slack", "workspace");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [
      tool("slack-find-message"),
      tool("slack-send-message"),
      tool("slack-create-draft"),
    ]);

    const { tools, close } = await loadEmailTools();
    const names = tools.map((t) => t.name);
    await close();

    expect(names).toContain("slack-send-message");
    expect(names).toContain("slack-create-draft");
    expect(names).not.toContain("slack-find-message"); // reads are never registered, gated or not
  });

  it("withholds provider write tools for every account when providerWrites is false, keeping drafts", async () => {
    const acc = account("acc-slack", "slack", "workspace");
    listAccountsMock.mockResolvedValue([acc]);
    // Same DB state as the test above — write access is armed for this
    // account under Settings → Permissions. providerWrites: false must
    // override that for this run regardless.
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [
      tool("slack-find-message"),
      tool("slack-send-message"),
      tool("slack-create-draft"),
    ]);

    const { tools, close } = await loadEmailTools({ providerWrites: false });
    const names = tools.map((t) => t.name);
    await close();

    expect(names).not.toContain("slack-send-message");
    expect(names).toContain("slack-create-draft");
    expect(names).not.toContain("slack-find-message");
  });

  it("never opens an MCP session for a write-armed account whose app has a DraftProvider once providerWrites is false, but still exposes the local draft and attachment tools", async () => {
    const acc = account("acc-gmail", "gmail", "kadim@gmail.com");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [tool("gmail-find-email"), tool("gmail-send-email")]);

    const { tools, close } = await loadEmailTools({ providerWrites: false });
    const names = tools.map((t) => t.name);
    await close();

    expect(connectCallCount).toBe(0);
    expect(closedAccountIds).toHaveLength(0);
    expect(names).not.toContain("gmail-send-email");
    expect(names).toContain("gmail-create-draft");
    expect(names).toContain("gmail-save-attachment");
  });
});

describe("loadEmailTools — unsubscribe tool gating", () => {
  it("registers an unsubscribe tool for a write-armed account whose app has a SyncProvider", async () => {
    const acc = account("acc-gmail-unsub-armed", "gmail", "kadim@gmail.com");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [tool("gmail-find-email"), tool("gmail-send-email")]);

    const { tools, close } = await loadEmailTools();
    const names = tools.map((t) => t.name);
    await close();

    expect(names).toContain("gmail-unsubscribe");
  });

  it("withholds the unsubscribe tool for a read-only account (write access not armed)", async () => {
    const acc = account("acc-gmail-unsub-readonly", "gmail", "kadim@gmail.com");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([]);
    toolsByAccountId.set(acc.id, [tool("gmail-find-email"), tool("gmail-send-email")]);

    const { tools, close } = await loadEmailTools();
    const names = tools.map((t) => t.name);
    await close();

    expect(names).not.toContain("gmail-unsubscribe");
  });

  it("withholds the unsubscribe tool for every account when providerWrites is false, even if write-armed", async () => {
    const acc = account("acc-gmail-unsub-pw", "gmail", "kadim@gmail.com");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [tool("gmail-find-email"), tool("gmail-send-email")]);

    const { tools, close } = await loadEmailTools({ providerWrites: false });
    const names = tools.map((t) => t.name);
    await close();

    expect(names).not.toContain("gmail-unsubscribe");
  });

  it("withholds the unsubscribe tool for a write-armed account whose app has no SyncProvider", async () => {
    const acc = account("acc-slack-unsub", "slack", "workspace");
    listAccountsMock.mockResolvedValue([acc]);
    writeAccessMock.mockResolvedValue([acc.id]);
    toolsByAccountId.set(acc.id, [tool("slack-send-message")]);

    const { tools, close } = await loadEmailTools();
    const names = tools.map((t) => t.name);
    await close();

    expect(names).not.toContain("slack-unsubscribe");
  });
});
