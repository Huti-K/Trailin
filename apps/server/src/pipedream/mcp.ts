import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AccountDescription, AgentCard, ConnectedAccount } from "@trailin/shared";
import { toCardAccount } from "../agent/cards.js";
import { composeDraftBody } from "../agent/composition.js";
import { defineTool, textResult } from "../agent/toolResult.js";
import { appendDraftVersion, createDraftSnapshot, getDraftCardDetails } from "../db/draftStore.js";
import { getAccountDescriptions, getWriteAccessAccounts } from "../db/settings.js";
import "../email/registerProviders.js";
import "../email/registerAttachmentProviders.js";
import "../email/sync/registerSyncProviders.js";
import { getAttachmentProvider } from "../email/attachmentProviders.js";
import { buildSaveAttachmentTool } from "../email/attachmentTool.js";
import { type CreateDraftInput, type DraftProvider, getDraftProvider } from "../email/providers.js";
import { getSyncProvider } from "../email/sync/syncProviders.js";
import { buildUnsubscribeTool } from "../email/unsubscribe/tool.js";
import { moduleLogger } from "../logger.js";
import {
  type ConnectConfig,
  getConnectConfig,
  getPipedreamAccessToken,
  listAccounts,
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
 * lets several accounts of the same app coexist in one agent.
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
 * Which MCP tools get registered at all. Reads (find/get/list/search/…) are
 * NEVER registered — the agent's read path is the local mailbox mirror
 * (agent/mailTools.ts), and a second live read path would just be slower and
 * inconsistent with it. What remains from MCP is the write surface: send,
 * reply, label, move, delete — gated per account by the write-access setting
 * (`account.writeAccess`), or off for every account regardless of that
 * setting when the caller passes `providerWrites: false` (unattended
 * automation runs, see loadEmailTools) — plus Pipedream's own create-draft
 * for apps without a DraftProvider (drafts never dispatch mail, so they're
 * fine on a read-only account, and fine when writes are forced off).
 */
const READ_VERBS = /^(find|get|list|search|download|fetch|retrieve)(-|$)/;
const DRAFT_ONLY = /^create-draft(-|$)/;

/** The MCP tool's action with the app-slug prefix stripped: "gmail-find-email" → "find-email". */
function actionOf(mcpToolName: string): string {
  return mcpToolName.replace(/^[a-z0-9_]+-/, "");
}

/** Short per-account tool-name suffix, e.g. "kadim" from kadim@gmail.com. */
export function accountSlug(account: ConnectedAccount): string {
  const local = account.name.split("@")[0] ?? account.name;
  const slug = local
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 24)
    .toLowerCase();
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
 * loadEmailTools. `session: null` means no MCP session exists for the
 * account — either the connect failed or the registration policy needed
 * none; `session` set but `mcpTools: null` means the session opened but
 * listTools failed. Both still get the account's non-MCP tools
 * (draft/attachment).
 */
interface AccountConnectResult {
  account: ConnectedAccount;
  session: McpSession | null;
  mcpTools: McpToolInfo[] | null;
}

/**
 * Wrap one account's already-fetched MCP tool list as pi AgentTools,
 * applying the read/write registration policy above.
 *
 * Takes `mcpTools` rather than fetching it itself: the network fetch runs in
 * parallel across accounts (see loadEmailTools), while this naming/dedup pass
 * stays synchronous and runs strictly in account order — which account "wins"
 * a bare tool name on a seenNames collision depends on processing order, so
 * that order must stay deterministic.
 */
function buildAccountTools(
  mcpTools: McpToolInfo[],
  session: McpSession,
  account: ConnectedAccount,
  needsSuffix: boolean,
  seenNames: Set<string>,
  allowWrite: boolean,
  purpose: string | undefined,
): AgentTool[] {
  const tools: AgentTool[] = [];
  const suffix = needsSuffix ? `__${accountSlug(account)}` : "";
  // The user's note on why this account is connected — appended to every tool
  // so the model understands what the connection is meant for.
  const purposeNote = purpose?.trim() ? ` This connection is used for: ${purpose.trim()}.` : "";
  // Tools dropped by the policy filter below — logged once after the loop so
  // the silent capability filtering is at least visible in debug logs.
  const skipped: string[] = [];

  for (const mcpTool of mcpTools) {
    // Pipedream's create-draft components are gated behind a paid workspace
    // on some apps (Gmail's needs File Stash); Trailin substitutes its own
    // proxy-based tool under the same slug for every app with a
    // DraftProvider, so skip Pipedream's version wherever ours takes over.
    if (getDraftProvider(account.app) && mcpTool.name === `${account.app}-create-draft`) continue;
    const action = actionOf(mcpTool.name);
    const isDraft = DRAFT_ONLY.test(action);
    if (READ_VERBS.test(action) || (!allowWrite && !isDraft)) {
      skipped.push(mcpTool.name);
      continue;
    }
    let name = sanitizeToolName(`${mcpTool.name}${suffix}`);
    if (seenNames.has(name)) name = sanitizeToolName(`${mcpTool.name}__${account.id}`);
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    tools.push({
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
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  }
  if (skipped.length > 0) {
    log.debug(
      { app: account.app, account: account.name, skipped },
      "registration policy dropped MCP tools",
    );
  }
  return tools;
}

/**
 * Trailin's own create-draft tool for one connected account, generalized
 * over any app with a DraftProvider. Replaces Pipedream's own component
 * with the same kind of tool, so prompts stay natural. Drafts never send
 * anything — allowed even on a read-only account.
 */
export function buildDraftTool(
  account: ConnectedAccount,
  name: string,
  provider: DraftProvider,
): AgentTool {
  return defineTool({
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
    },
    execute: async (_toolCallId, params) => {
      const input = params as unknown as CreateDraftInput;
      // The compose pipeline (agent/composition.ts) runs before the body ever
      // reaches the provider, so every surface that saves a draft (chat,
      // automations) gets the same humanizer + signature treatment.
      const composed = await composeDraftBody(account.id, {
        body: input.body,
        subject: input.subject,
      });
      const finalBody = composed.body;

      const result = await provider.createDraft(account, {
        ...input,
        body: composed.htmlBody ?? finalBody,
        ...(composed.htmlBody ? { bodyFormat: "html" as const } : {}),
      });

      // Snapshot the plain-text semantic body for the learning loop. The
      // provider may save an HTML MIME body solely to preserve rich signature
      // formatting, but that markup should not become writing-style evidence.
      try {
        await createDraftSnapshot({
          accountId: account.id,
          providerDraftId: result.draftId,
          providerMessageId: result.messageId,
          threadId: input.threadId ?? (result.threadId || undefined),
          subject: input.subject,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          signature: composed.signature,
          body: finalBody,
        });
      } catch (error) {
        log.warn({ err: error, draftId: result.draftId }, "recording draft snapshot failed");
      }

      let text =
        `Draft created in ${account.name} (draft id ${result.draftId}). It is unsent, and the ` +
        `full draft is shown to the user as a card in this conversation — don't repeat its ` +
        `subject or body in your reply.`;

      // Show the saved body once, whenever it differs from what the model
      // submitted — whether that's the humanizer, the signature, or both.
      if (finalBody !== input.body) {
        const reasons: string[] = [];
        if (composed.humanized) reasons.push("lightly edited by the humanizer pass");
        if (composed.signatureAppended) reasons.push("had the account's signature appended");
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
          signatureAppended: composed.signatureAppended,
        },
      };

      return textResult(text, card);
    },
  });
}

/**
 * Rewrite an existing draft in place — the tool a chat refinement uses so
 * "make it firmer" edits the SAME draft instead of creating a second one.
 * Runs the same compose pipeline as create (humanizer; signature appended
 * when missing, so it survives a full-body rewrite) and appends an
 * agent-authored version to the draft's snapshot history. Only built for
 * accounts whose provider implements updateDraft.
 */
export function buildUpdateDraftTool(
  account: ConnectedAccount,
  name: string,
  provider: DraftProvider,
): AgentTool {
  return defineTool({
    name,
    label: "Update email draft",
    description:
      `Rewrite an existing unsent draft in this account's Drafts folder in place. Use this ` +
      `whenever the user asks to refine, shorten, or otherwise change a draft that already ` +
      `exists (you know its draft id from creating or listing it) — never create a second ` +
      `draft for a refinement. Nothing is sent. The new body goes through the same humanizer ` +
      `pass as draft creation, and the account's configured signature is preserved ` +
      `automatically — do not write one yourself. Recipients cannot be changed; if the user ` +
      `wants different recipients, discard and create a new draft instead.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    parameters: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Id of the existing draft to rewrite." },
        body: { type: "string", description: "The full replacement plain-text body." },
        subject: { type: "string", description: "Replacement subject line, if it changes." },
      },
      required: ["draftId"],
    },
    execute: async (_toolCallId, params) => {
      const { draftId, body, subject } = params as {
        draftId: string;
        body?: string;
        subject?: string;
      };
      if (body === undefined && subject === undefined) {
        return textResult("Nothing to update: pass a new body and/or subject.");
      }

      let finalBody = body;
      let signatureAppended = false;
      if (body !== undefined) {
        const composed = await composeDraftBody(account.id, { body, subject });
        finalBody = composed.body;
        signatureAppended = composed.signatureAppended;
      }

      if (!provider.updateDraft) {
        return textResult("Updating drafts is not supported for this account.");
      }
      await provider.updateDraft(account, draftId, {
        ...(finalBody !== undefined ? { body: finalBody } : {}),
        ...(subject !== undefined ? { subject } : {}),
      });

      // Agent rewrites append to the snapshot's version history (author
      // "agent") so the learning loop diffs against the LAST agent version.
      // Best-effort: a draft without a snapshot just isn't tracked.
      await appendDraftVersion(account.id, draftId, "agent", {
        body: finalBody,
        subject,
      }).catch((error: unknown) =>
        log.warn({ err: error, draftId }, "appending agent draft version failed"),
      );

      // Re-render the draft card so the conversation shows the updated text —
      // the card from the create turn keeps its old body forever.
      const details = await getDraftCardDetails(account.id, draftId);
      if (details) {
        const card: AgentCard = {
          kind: "email_draft",
          account: toCardAccount(account),
          draft: {
            draftId,
            ...(details.threadId ? { threadId: details.threadId } : {}),
            subject: subject ?? details.subject,
            to: details.to,
            ...(details.cc.length > 0 ? { cc: details.cc } : {}),
            ...(details.bcc.length > 0 ? { bcc: details.bcc } : {}),
            body: finalBody ?? details.body,
            signatureAppended,
          },
        };
        return textResult(
          `Draft ${draftId} updated in ${account.name}. It remains unsent, and the updated ` +
            `draft is shown to the user as a card in this conversation — don't repeat its ` +
            `subject or body in your reply.`,
          card,
        );
      }

      // No snapshot (not agent-written): there are no recipients to build a
      // card from, so the saved text has to travel in the reply instead.
      let text = `Draft ${draftId} updated in ${account.name}. It remains unsent.`;
      if (finalBody !== undefined && finalBody !== body) {
        text += `\n\nThe saved body reads:\n\n${finalBody}`;
      }
      return textResult(text);
    },
  });
}

export interface EmailToolset {
  tools: AgentTool[];
  close: () => Promise<void>;
}

export interface LoadEmailToolsOptions {
  /**
   * Whether any account's write-access setting can grant MCP write tools
   * (send, reply, label, move, delete). Defaults to true. Pass false to run
   * every account through the same gating machinery as a read-only account —
   * no account contributes a write tool, no matter what's stored in
   * Settings → Permissions. Draft tools are unaffected either way: creating a
   * draft never dispatches mail, so it stays available on every account.
   * Used for unattended automation runs, where a prompt-injected email must
   * not be able to trigger a send.
   */
  providerWrites?: boolean;
}

const EMPTY_TOOLSET: EmailToolset = { tools: [], close: async () => {} };

/**
 * Load the agent's per-account email WRITE tools (the read path is the local
 * mirror — agent/mailTools.ts): one pinned MCP session per connected account
 * that can actually contribute MCP tools, plus the local draft and
 * attachment tools. With several accounts of the same app, tool names get an
 * account suffix (gmail-send-email__work vs gmail-send-email__personal).
 * Accounts that fail to connect are skipped — the agent works with what's
 * left.
 */
export async function loadEmailTools(options: LoadEmailToolsOptions = {}): Promise<EmailToolset> {
  const providerWrites = options.providerWrites ?? true;
  const config = await getConnectConfig();
  if (!config) return EMPTY_TOOLSET;

  let accounts: ConnectedAccount[];
  let writeAccessIds: string[];
  let descriptions: AccountDescription[];
  try {
    [accounts, , writeAccessIds, descriptions] = await Promise.all([
      listAccounts(),
      // Warm/validate the token cache before opening N MCP sessions below —
      // bad credentials fail here once instead of as N identical connect
      // failures. Each session's transport re-fetches through
      // getPipedreamAccessToken() per request (see fetchWithFreshToken)
      // rather than reusing this snapshot.
      getPipedreamAccessToken(),
      getWriteAccessAccounts(),
      getAccountDescriptions(),
    ]);
  } catch (error) {
    log.warn({ err: error }, "listing Pipedream accounts failed");
    return EMPTY_TOOLSET;
  }
  if (accounts.length === 0) return EMPTY_TOOLSET;

  // Empty when providerWrites is false: every account then falls through the
  // same `writeAccess.has(account.id)` checks below as a read-only account,
  // regardless of what's stored under Settings → Permissions.
  const writeAccess = providerWrites ? new Set(writeAccessIds) : new Set<string>();
  const purposeByAccount = new Map(descriptions.map((d) => [d.accountId, d.text]));

  const perApp = new Map<string, number>();
  for (const account of accounts) perApp.set(account.app, (perApp.get(account.app) ?? 0) + 1);

  // On a read-only account, an app with a DraftProvider cannot contribute a
  // single MCP tool (reads are never registered, writes are gated off for
  // this account, and Pipedream's create-draft is superseded by ours) —
  // don't open an MCP session for it at all. That keeps a read-only account
  // MCP-free for any app with a draft driver: only the draft/attachment
  // tools below.
  const needsMcp = (account: ConnectedAccount): boolean =>
    writeAccess.has(account.id) || !getDraftProvider(account.app);

  // Connect + list tools for every account in parallel — two independent
  // network round-trips per account (a remote MCP handshake, then a
  // listTools call) that don't depend on any other account. Each attempt
  // resolves to a per-account result rather than rejecting, so one account's
  // failure can't drop or reorder the others, and every log line below still
  // carries its own account/app fields. The naming/dedup pass that consumes
  // these results stays a separate, synchronous, account-ordered loop (see
  // buildAccountTools) so tool naming stays deterministic.
  const connectResults = await Promise.all(
    accounts.map(async (account): Promise<AccountConnectResult> => {
      if (!needsMcp(account)) return { account, session: null, mcpTools: null };
      let session: McpSession;
      try {
        session = await connectForAccount(account, config);
      } catch (error) {
        log.warn(
          { err: error, app: account.app, account: account.name },
          "MCP session failed for account",
        );
        return { account, session: null, mcpTools: null };
      }
      try {
        const { tools: mcpTools } = await session.client.listTools();
        return { account, session, mcpTools };
      } catch (error) {
        log.warn(
          { err: error, app: account.app, account: account.name },
          "listing tools failed for account",
        );
        return { account, session, mcpTools: null };
      }
    }),
  );

  const sessions: McpSession[] = [];
  const tools: AgentTool[] = [];
  const seenNames = new Set<string>();

  for (const { account, session, mcpTools } of connectResults) {
    // A failed connect for an account that needed MCP still gets its local
    // draft/attachment tools below — those go through the Connect proxy, not
    // the MCP session.
    if (session) sessions.push(session);
    const needsSuffix = (perApp.get(account.app) ?? 0) > 1;
    if (session && mcpTools) {
      // One account's tool assembly failing must not abort the accounts
      // after it in this loop.
      try {
        tools.push(
          ...buildAccountTools(
            mcpTools,
            session,
            account,
            needsSuffix,
            seenNames,
            writeAccess.has(account.id),
            purposeByAccount.get(account.id),
          ),
        );
      } catch (error) {
        log.warn(
          { err: error, app: account.app, account: account.name },
          "building tools failed for account",
        );
      }
    }
    const suffix = needsSuffix ? `__${accountSlug(account)}` : "";
    const draftProvider = getDraftProvider(account.app);
    if (draftProvider) {
      const name = sanitizeToolName(`${account.app}-create-draft${suffix}`);
      if (!seenNames.has(name)) {
        seenNames.add(name);
        // Never handed to background workers (delegate builds its toolset
        // from the mirror read tools only), so workers cannot create drafts.
        tools.push(buildDraftTool(account, name, draftProvider));
      }
      if (draftProvider.updateDraft) {
        const updateName = sanitizeToolName(`${account.app}-update-draft${suffix}`);
        if (!seenNames.has(updateName)) {
          seenNames.add(updateName);
          // Same footing as create-draft: rewrites an unsent draft, never
          // dispatches mail, so it stays available on read-only accounts.
          tools.push(buildUpdateDraftTool(account, updateName, draftProvider));
        }
      }
    }
    const attachmentProvider = getAttachmentProvider(account.app);
    if (attachmentProvider) {
      const name = sanitizeToolName(`${account.app}-save-attachment${suffix}`);
      if (!seenNames.has(name)) {
        seenNames.add(name);
        // Reads mail but writes only into the local document library, so it's
        // fine on a read-only account.
        tools.push(buildSaveAttachmentTool(account, name, attachmentProvider));
      }
    }
    // Fires a real HTTP request to a third party (RFC 8058 one-click POST) —
    // same write-arming bar as an MCP send/reply/delete tool, and only for
    // accounts whose mailbox is actually mirrored (no SyncProvider means no
    // local mail to look an unsubscribe link up from).
    if (writeAccess.has(account.id) && getSyncProvider(account.app)) {
      const name = sanitizeToolName(`${account.app}-unsubscribe${suffix}`);
      if (!seenNames.has(name)) {
        seenNames.add(name);
        tools.push(buildUnsubscribeTool(account, name));
      }
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.all(sessions.map((s) => s.close()));
    },
  };
}
