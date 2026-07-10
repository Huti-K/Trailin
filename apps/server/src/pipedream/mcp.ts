import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AccountDescription, AgentCard, ConnectedAccount } from "@trailin/shared";
import { cardFromMcpResult, toCardAccount } from "../agent/cards.js";
import { humanizeDraftBody } from "../agent/humanizer.js";
import { getVoiceFor } from "../agent/voice.js";
import { buildDemoEmailToolset } from "../demo/emailTools.js";
import { getAccountDescriptions, getEmailWriteSetting } from "../db/settings.js";
import "../email/registerProviders.js";
import "../email/registerAttachmentProviders.js";
import { getDraftProvider, type CreateDraftInput, type DraftProvider } from "../email/providers.js";
import { getAttachmentProvider } from "../email/attachmentProviders.js";
import { env } from "../env.js";
import { moduleLogger } from "../logger.js";
import { buildSaveAttachmentTool } from "../email/attachmentTool.js";
import {
  getConnectConfig,
  getPipedreamAccessToken,
  listAccounts,
  type ConnectConfig,
} from "./connect.js";

const log = moduleLogger("mcp");

const MCP_BASE_URL = "https://remote.mcp.pipedream.net/v3";

interface McpSession {
  client: McpClient;
  close: () => Promise<void>;
}

/**
 * StreamableHTTPClientTransport calls this for every HTTP request it makes
 * (initial SSE probe, each tool call POST, session teardown) — see its
 * `send`/`_startOrAuthSse`/`terminateSession`, which all do
 * `(this._fetch ?? fetch)(url, init)`. Injecting the Authorization header
 * here, instead of baking a snapshot into `requestInit.headers` once at
 * transport construction, is what keeps a long-lived cached MCP session
 * (agent sessions are cached upstream with an idle-refreshing TTL, so a busy
 * session can live indefinitely) authorized past the token's original expiry.
 *
 * getPipedreamAccessToken() is cheap to call per request: it resolves through
 * @pipedream/sdk's OAuthTokenProvider (core/auth/OAuthTokenProvider), which
 * caches the token in memory and only performs a network refresh once it's
 * within its own 2-minute safety buffer of expiring — so this is an in-memory
 * read almost every time, not a token fetch per tool call.
 */
const fetchWithFreshToken: FetchLike = async (url, init) => {
  const token = await getPipedreamAccessToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};

/**
 * Open an MCP session pinned to ONE connected account. "tools-only" mode
 * exposes tools with real structured parameters (no sub-agent indirection);
 * x-pd-account-id makes every tool act as exactly this account, which is what
 * lets several Gmail/Outlook accounts coexist in one agent.
 */
async function connectForAccount(
  account: ConnectedAccount,
  config: ConnectConfig,
): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_BASE_URL), {
    fetch: fetchWithFreshToken,
    requestInit: {
      headers: {
        "x-pd-project-id": config.projectId,
        "x-pd-environment": config.environment,
        "x-pd-external-user-id": config.externalUserId,
        "x-pd-app-slug": account.app,
        "x-pd-account-id": account.id,
        "x-pd-tool-mode": "tools-only",
      },
    },
  });
  const client = new McpClient({ name: "trailin-email-agent", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/** Tool names must satisfy the LLM providers' [a-zA-Z0-9_-]{1,128} constraint. */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/**
 * Read-only guard: unless the user allows changes, only tools that cannot
 * touch anything pass — reading/searching/downloading, plus explicit
 * draft-creation tools (they never dispatch mail). Everything else (send,
 * delete, label, move, update, …) is never registered, so the model cannot
 * call it even by accident.
 */
const SAFE_VERBS = /^(find|get|list|search|download|fetch|retrieve)(-|$)/;
const DRAFT_ONLY = /^create-draft(-|$)/;

/**
 * True for pure read/search actions only, never drafts. This is the strict
 * subset handed to background delegate workers, which must not create
 * drafts even though a draft never sends anything.
 */
function isReadAction(mcpToolName: string): boolean {
  // Strip the app-slug prefix: "gmail-find-email" -> "find-email".
  const action = mcpToolName.replace(/^[a-z0-9_]+-/, "");
  return SAFE_VERBS.test(action);
}

function allowedInReadOnly(mcpToolName: string): boolean {
  const strippedAction = mcpToolName.replace(/^[a-z0-9_]+-/, "");
  return isReadAction(mcpToolName) || DRAFT_ONLY.test(strippedAction);
}

/** Short per-account tool-name suffix, e.g. "kadim" from kadim@gmail.com. */
export function accountSlug(account: ConnectedAccount): string {
  const local = account.name.split("@")[0] ?? account.name;
  const slug = local.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).toLowerCase();
  return slug || account.id.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
}

function mcpContentToText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        const b = block as { type: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") return b.text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

/** Element type of session.client.listTools()'s `tools` array. */
type McpToolInfo = Awaited<ReturnType<McpClient["listTools"]>>["tools"][number];

/**
 * One account's outcome from the parallel connect+listTools phase in
 * loadEmailTools. `session: null` means connectForAccount itself failed
 * (skip the account entirely); `session` set but `mcpTools: null` means the
 * session opened but listTools failed (still build the account's non-MCP
 * tools — draft/attachment — same as before parallelizing this).
 */
interface AccountConnectResult {
  account: ConnectedAccount;
  session: McpSession | null;
  mcpTools: McpToolInfo[] | null;
}

/**
 * Wrap one account's already-fetched MCP tool list as pi AgentTools. Also
 * returns the strict read-only subset (see isReadAction) so callers can
 * build the separate toolset background delegate workers get.
 *
 * Takes `mcpTools` rather than fetching it itself — that fetch now runs in
 * parallel across accounts (see loadEmailTools) — so this naming/dedup pass
 * stays synchronous and can still run strictly in account order: which
 * account "wins" a bare tool name on a seenNames collision depends on
 * processing order, and parallelizing the network fetch must not change that.
 */
function buildAccountTools(
  mcpTools: McpToolInfo[],
  session: McpSession,
  account: ConnectedAccount,
  needsSuffix: boolean,
  seenNames: Set<string>,
  allowWrite: boolean,
  purpose: string | undefined,
): { tools: AgentTool[]; readTools: AgentTool[] } {
  const tools: AgentTool[] = [];
  const readTools: AgentTool[] = [];
  const suffix = needsSuffix ? `__${accountSlug(account)}` : "";
  // The user's note on why this account is connected — appended to every tool
  // so the model understands what the connection is meant for.
  const purposeNote = purpose?.trim() ? ` This connection is used for: ${purpose.trim()}.` : "";
  const cardAccount = toCardAccount(account);
  // Tools dropped by the read-only filter below — logged once after the loop
  // so the silent capability filtering is at least visible in debug logs.
  const skipped: string[] = [];

  for (const mcpTool of mcpTools) {
    // Pipedream's create-draft components are gated behind a paid workspace
    // on some apps (Gmail's needs File Stash); Trailin substitutes its own
    // proxy-based tool under the same slug for every app with a
    // DraftProvider, so skip Pipedream's version wherever ours takes over.
    if (getDraftProvider(account.app) && mcpTool.name === `${account.app}-create-draft`) continue;
    if (!allowWrite && !allowedInReadOnly(mcpTool.name)) {
      skipped.push(mcpTool.name);
      continue;
    }
    let name = sanitizeToolName(`${mcpTool.name}${suffix}`);
    if (seenNames.has(name)) name = sanitizeToolName(`${mcpTool.name}__${account.id}`);
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    // "gmail-find-email" -> "find-email"; used by cardFromMcpResult to pick a shape.
    const action = mcpTool.name.startsWith(`${account.app}-`)
      ? mcpTool.name.slice(account.app.length + 1)
      : mcpTool.name;

    const tool: AgentTool = {
      name,
      label: mcpTool.title ?? mcpTool.name,
      description: `${mcpTool.description ?? mcpTool.name}\n\nActs as the connected account: ${account.name}.${purposeNote}`,
      // MCP input schemas are plain JSON Schema, which is exactly what
      // TypeBox schemas compile to — pass through as-is.
      parameters: mcpTool.inputSchema as AgentTool["parameters"],
      execute: async (_toolCallId, params, signal) => {
        const result = await session.client.callTool(
          { name: mcpTool.name, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          { signal },
        );
        const text = mcpContentToText(result.content);
        if (result.isError) {
          throw new Error(text || `Tool ${mcpTool.name} failed`);
        }
        // Best-effort — see cards.ts. A miss just falls back to the plain tool badge.
        const details = cardFromMcpResult(action, cardAccount, result);
        return { content: [{ type: "text", text }], details };
      },
    };
    tools.push(tool);
    if (isReadAction(mcpTool.name)) readTools.push(tool);
  }
  if (skipped.length > 0) {
    log.debug({ app: account.app, account: account.name, skipped }, "read-only mode dropped write tools");
  }
  return { tools, readTools };
}

/**
 * Trailin's own create-draft tool for one connected account, generalized
 * over any app with a DraftProvider. The single create-draft tool builder
 * for both the live path here and demo mode (demo/emailTools.ts, always with
 * gmailDrafts.ts's gmailDraftProvider). Replaces Pipedream's own component
 * with the same kind of tool, so prompts stay natural. Drafts never send
 * anything — allowed even in read-only mode.
 */
export function buildDraftTool(account: ConnectedAccount, name: string, provider: DraftProvider): AgentTool {
  return {
    name,
    label: "Create email draft",
    description:
      `Create an unsent draft email in this account's Drafts folder — nothing is sent; the ` +
      `user reviews and sends it themselves. Pass threadId to attach the draft to an existing ` +
      `conversation (use the thread's id from find/list tools), where the connected provider ` +
      `supports it. The body goes through a humanizer pass before saving, which removes ` +
      `AI-sounding phrasing; the tool result reports the final saved text when it was adjusted. ` +
      `If this account has a signature configured in Settings, it is appended automatically — ` +
      `do not write a signature block yourself.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        cc: { type: "array", items: { type: "string" }, description: "Cc addresses." },
        bcc: { type: "array", items: { type: "string" }, description: "Bcc addresses." },
        subject: { type: "string", description: "Subject line." },
        body: { type: "string", description: "Plain-text body of the draft." },
        threadId: {
          type: "string",
          description: "Optional thread id to attach this draft to (for replies), when supported.",
        },
      },
      required: ["to", "subject", "body"],
    } as AgentTool["parameters"],
    execute: async (_toolCallId, params) => {
      const input = params as unknown as CreateDraftInput;
      // Copy-edit the body before it ever reaches the provider, so every
      // surface that saves a draft (chat, automations) gets the same pass.
      const humanized = await humanizeDraftBody({ body: input.body, subject: input.subject });

      // Append the account's signature (if any) after the humanizer, unless
      // the (humanized) body already contains it — compared loosely so minor
      // whitespace differences don't cause a duplicate signature.
      const voice = await getVoiceFor(account.id);
      const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
      let finalBody = humanized.body;
      let signatureAppended = false;
      const signature = voice?.signature?.trim();
      if (signature && !normalize(finalBody).includes(normalize(signature))) {
        finalBody = `${finalBody}\n\n${signature}`;
        signatureAppended = true;
      }

      const result = await provider.createDraft(account, { ...input, body: finalBody });
      const providerLabel = account.appName ?? "the provider's";
      let text = `Draft created in ${account.name} (draft id ${result.draftId}). It is unsent — the user can review it on the Drafts page or in ${providerLabel} web UI.`;

      // Show the saved body once, whenever it differs from what the model
      // submitted — whether that's the humanizer, the signature, or both.
      if (finalBody !== input.body) {
        const reasons: string[] = [];
        if (humanized.changed) reasons.push("lightly edited by the humanizer pass");
        if (signatureAppended) reasons.push("had the account's signature appended");
        const reasonText = reasons.length > 0 ? ` (${reasons.join(" and ")})` : "";
        text += `\n\nThe saved draft reads${reasonText}:\n\n${finalBody}`;
      }

      const card: AgentCard = {
        kind: "email_draft",
        account: toCardAccount(account),
        draft: {
          draftId: result.draftId,
          threadId: result.threadId,
          subject: input.subject,
          to: input.to,
          ...(input.cc?.length ? { cc: input.cc } : {}),
          ...(input.bcc?.length ? { bcc: input.bcc } : {}),
          body: finalBody,
          webUrl: result.webUrl,
          signatureAppended,
        },
      };

      return {
        content: [{ type: "text", text }],
        details: card,
      };
    },
  };
}

export interface EmailToolset {
  tools: AgentTool[];
  /**
   * The strictly read-only email tools (search/read, no drafts, no sends)
   * given to background delegate workers.
   */
  readTools: AgentTool[];
  close: () => Promise<void>;
}

const EMPTY_TOOLSET: EmailToolset = { tools: [], readTools: [], close: async () => {} };

/**
 * Load the agent's email tools: one pinned MCP session per connected account.
 * With several accounts of the same app, tool names get an account suffix
 * (gmail-send-email__work vs gmail-send-email__personal). Accounts that fail
 * to connect are skipped — the agent works with what's left.
 */
export async function loadEmailTools(): Promise<EmailToolset> {
  // Demo mode never opens an MCP session or otherwise calls Pipedream — its
  // tools search/read the seeded MAILBOX instead of what the agent would
  // normally fetch live.
  if (env.demoMode) return buildDemoEmailToolset();

  const config = await getConnectConfig();
  if (!config) return EMPTY_TOOLSET;

  let accounts: ConnectedAccount[];
  let allowWrite: boolean;
  let descriptions: AccountDescription[];
  try {
    [accounts, , allowWrite, descriptions] = await Promise.all([
      listAccounts(),
      // Warm/validate the token cache before opening N MCP sessions below —
      // bad credentials fail here once instead of as N identical connect
      // failures. Each session's transport re-fetches through
      // getPipedreamAccessToken() per request (see fetchWithFreshToken)
      // rather than reusing this snapshot.
      getPipedreamAccessToken(),
      getEmailWriteSetting(),
      getAccountDescriptions(),
    ]);
  } catch (error) {
    log.warn({ err: error }, "listing Pipedream accounts failed");
    return EMPTY_TOOLSET;
  }
  if (accounts.length === 0) return EMPTY_TOOLSET;

  const purposeByAccount = new Map(descriptions.map((d) => [d.accountId, d.text]));

  const perApp = new Map<string, number>();
  for (const account of accounts) perApp.set(account.app, (perApp.get(account.app) ?? 0) + 1);

  // Connect + list tools for every account in parallel — two independent
  // network round-trips per account (a remote MCP handshake, then a
  // listTools call) that don't depend on any other account. Each attempt
  // resolves to a per-account result rather than rejecting, so one account's
  // failure can't drop or reorder the others, and every log line below still
  // carries its own account/app fields. The naming/dedup pass that consumes
  // these results stays a separate, synchronous, account-ordered loop (see
  // buildAccountTools) so tool naming is exactly as deterministic as it was
  // running fully sequentially.
  const connectResults = await Promise.all(
    accounts.map(async (account): Promise<AccountConnectResult> => {
      let session: McpSession;
      try {
        session = await connectForAccount(account, config);
      } catch (error) {
        log.warn({ err: error, app: account.app, account: account.name }, "MCP session failed for account");
        return { account, session: null, mcpTools: null };
      }
      try {
        const { tools: mcpTools } = await session.client.listTools();
        return { account, session, mcpTools };
      } catch (error) {
        log.warn({ err: error, app: account.app, account: account.name }, "listing tools failed for account");
        return { account, session, mcpTools: null };
      }
    }),
  );

  const sessions: McpSession[] = [];
  const tools: AgentTool[] = [];
  const readTools: AgentTool[] = [];
  const seenNames = new Set<string>();

  for (const { account, session, mcpTools } of connectResults) {
    if (!session) continue;
    sessions.push(session);
    const needsSuffix = (perApp.get(account.app) ?? 0) > 1;
    if (mcpTools) {
      // buildAccountTools is now pure sync (its own listTools call already
      // succeeded above), but keep it guarded the way the combined
      // fetch+build step was before splitting them: one account's tool
      // assembly failing must not abort the accounts after it in this loop.
      try {
        const bridged = buildAccountTools(
          mcpTools,
          session,
          account,
          needsSuffix,
          seenNames,
          allowWrite,
          purposeByAccount.get(account.id),
        );
        tools.push(...bridged.tools);
        readTools.push(...bridged.readTools);
      } catch (error) {
        log.warn({ err: error, app: account.app, account: account.name }, "building tools failed for account");
      }
    }
    const suffix = needsSuffix ? `__${accountSlug(account)}` : "";
    const draftProvider = getDraftProvider(account.app);
    if (draftProvider) {
      const name = sanitizeToolName(`${account.app}-create-draft${suffix}`);
      if (!seenNames.has(name)) {
        seenNames.add(name);
        // The custom draft tool is never read-only: it's kept out of
        // readTools so background workers cannot create drafts.
        tools.push(buildDraftTool(account, name, draftProvider));
      }
    }
    const attachmentProvider = getAttachmentProvider(account.app);
    if (attachmentProvider) {
      const name = sanitizeToolName(`${account.app}-save-attachment${suffix}`);
      if (!seenNames.has(name)) {
        seenNames.add(name);
        // Reads mail but writes only into the local document library, so it's
        // fine in read-only mode; kept out of readTools so background workers
        // can't grow the library.
        tools.push(buildSaveAttachmentTool(account, name, attachmentProvider));
      }
    }
  }

  return {
    tools,
    readTools,
    close: async () => {
      await Promise.all(sessions.map((s) => s.close()));
    },
  };
}
