import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectedAccount } from "@trailin/shared";
import { moduleLogger } from "../../core/logger.js";
import { type ConnectConfig, getPipedreamAccessToken } from "./connect.js";

/**
 * One account's live Pipedream MCP session: pinned connect, per-request token
 * refresh, and a self-healing call path. Every call is bounded by a timeout,
 * and transport failures reconnect once, replaying reads but never writes.
 */

const log = moduleLogger("mcp");

const MCP_BASE_URL = "https://remote.mcp.pipedream.net/v3";

export interface McpSession {
  client: McpClient;
  close: () => Promise<void>;
}

/**
 * StreamableHTTPClientTransport calls this for every HTTP request. Injecting
 * the Authorization header per request, rather than baking a snapshot into
 * requestInit.headers at construction, keeps a long-lived cached session
 * authorized past the token's original expiry. getPipedreamAccessToken() is an
 * in-memory read almost every time (the SDK refreshes only within 2 minutes of
 * expiry), not a token fetch per call.
 */
const fetchWithFreshToken: FetchLike = async (url, init) => {
  const token = await getPipedreamAccessToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};

/**
 * Open an MCP session pinned to ONE connected account. x-pd-account-id makes
 * every tool act as this account, which lets several accounts of the same app
 * coexist in one agent; "tools-only" mode exposes real structured parameters.
 */
export async function connectForAccount(
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

/** Ceiling on one MCP tool call; a hung call fails here instead of stalling the turn. */
const MCP_CALL_TIMEOUT_MS = 60_000;

/**
 * One account's live MCP session behind a mutable handle. Tool closures hold
 * the box, not a session, so a reconnect swaps the session under every tool at
 * once. `closed` pins the box shut: a reconnect can't resurrect a
 * connection after the toolset was disposed.
 */
export interface McpSessionBox {
  current: McpSession;
  /** In-flight reconnect shared by concurrently failing calls, so N parallel calls trigger one. */
  reconnecting?: Promise<void>;
  closed: boolean;
}

/** A call that outlived MCP_CALL_TIMEOUT_MS (the SDK rejects it with RequestTimeout). */
export function isMcpTimeoutError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

/**
 * A failure of the transport or session itself (connection dropped, session
 * discarded per the MCP spec's HTTP 404, or the request never sent), not the
 * tool reporting an error. These a reconnect can heal; auth/config rejections
 * (401/403) would fail identically on a fresh session, so they pass through.
 */
export function isMcpTransportError(error: unknown): boolean {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  if (error instanceof StreamableHTTPError) {
    return error.code === undefined || error.code === 404 || error.code >= 500;
  }
  if (error instanceof Error) {
    return /fetch failed|network|socket hang up|other side closed|premature close|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i.test(
      error.message,
    );
  }
  return false;
}

/**
 * Replace the box's dead session with a fresh one. Deduped: concurrently
 * failing calls await the same attempt. A box whose toolset was closed refuses
 * to reconnect, so disposal stays final.
 */
function reconnectSession(
  box: McpSessionBox,
  account: ConnectedAccount,
  config: ConnectConfig,
): Promise<void> {
  if (box.reconnecting) return box.reconnecting;
  const attempt = (async () => {
    if (box.closed) throw new Error(`the connection to ${account.name} was closed`);
    void box.current.close().catch(() => {});
    const fresh = await connectForAccount(account, config);
    if (box.closed) {
      // The toolset was disposed mid-reconnect; don't let the fresh connection
      // outlive close().
      await fresh.close().catch(() => {});
      throw new Error(`the connection to ${account.name} was closed`);
    }
    box.current = fresh;
    log.info({ app: account.app, account: account.name }, "MCP session reconnected");
  })();
  box.reconnecting = attempt.finally(() => {
    box.reconnecting = undefined;
  });
  return box.reconnecting;
}

type McpCallResult = Awaited<ReturnType<McpClient["callTool"]>>;

/**
 * One tool call against the box's current session, bounded by
 * MCP_CALL_TIMEOUT_MS. Transport failures heal in place: reconnect once and
 * replay a read on the fresh session; a write is never replayed, since the
 * dropped call may have taken effect, so the model is told to verify. Timeouts
 * pass through with steering text (usually a too-broad query, the model's fix).
 */
export async function callWithRevival(
  box: McpSessionBox,
  account: ConnectedAccount,
  config: ConnectConfig,
  toolName: string,
  args: Record<string, unknown>,
  replayable: boolean,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  const call = () =>
    box.current.client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: MCP_CALL_TIMEOUT_MS,
    });
  try {
    return await call();
  } catch (error) {
    // The turn was aborted (client disconnect, run deadline): nothing to heal.
    // Checked first, because the SDK surfaces an external abort as a
    // RequestTimeout McpError too.
    if (signal?.aborted) throw error;
    if (isMcpTimeoutError(error)) {
      throw new Error(
        `${toolName} timed out after ${Math.round(MCP_CALL_TIMEOUT_MS / 1000)}s. Retry once with ` +
          `a narrower query (fewer results, a tighter date range); if that also fails, say ` +
          `plainly what you could not check.`,
      );
    }
    if (!isMcpTransportError(error) || box.closed) throw error;
    if (!replayable) {
      // Heal the session for whatever runs next, but never replay a write: the
      // dropped call may have gone through before the connection died.
      void reconnectSession(box, account, config).catch(() => {});
      throw new Error(
        `The connection to ${account.name} dropped during ${toolName}, so the action may or may ` +
          `not have taken effect. The connection is being restored — verify the outcome with a ` +
          `read tool before retrying.`,
      );
    }
    log.warn(
      { err: error, app: account.app, account: account.name, tool: toolName },
      "MCP call hit a transport failure, reconnecting",
    );
    await reconnectSession(box, account, config);
    return await call();
  }
}
