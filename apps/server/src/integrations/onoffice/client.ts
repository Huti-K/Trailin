import { createHmac } from "node:crypto";
import { moduleLogger } from "../../core/logger.js";

/**
 * Thin client for the onOffice CRM API: token + secret auth, each action
 * individually HMAC-signed (hmac_version 2). Read-only batches retry transient
 * failures with backoff; any mutating batch never retries, since a lost
 * response leaves the write's fate unknown and a blind retry could duplicate it.
 */

const log = moduleLogger("onoffice");

/** Hard per-attempt deadline so a hung connection can't stall a run. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export const ACTION_URN = {
  read: "urn:onoffice-de-ns:smart:2.5:smartml:action:read",
  create: "urn:onoffice-de-ns:smart:2.5:smartml:action:create",
  modify: "urn:onoffice-de-ns:smart:2.5:smartml:action:modify",
  delete: "urn:onoffice-de-ns:smart:2.5:smartml:action:delete",
  get: "urn:onoffice-de-ns:smart:2.5:smartml:action:get",
  do: "urn:onoffice-de-ns:smart:2.5:smartml:action:do",
} as const;

export type ActionType = keyof typeof ACTION_URN;

export function resolveActionId(action: string): string {
  if (action in ACTION_URN) return ACTION_URN[action as ActionType];
  return action; // already a URN
}

export interface ActionInput {
  actionid: string;
  resourcetype: string;
  resourceid?: string | number;
  identifier?: string;
  parameters?: Record<string, unknown>;
}

export interface OnOfficeClientConfig {
  token: string;
  secret: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
}

export const STABLE_URL = "https://api.onoffice.de/api/stable/api.php";

export class OnOfficeClient {
  private readonly token: string;
  private readonly secret: string;
  readonly apiUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(config: OnOfficeClientConfig) {
    if (!config.token || !config.secret) {
      throw new Error("onOffice credentials missing: set a token and secret in Settings.");
    }
    this.token = config.token;
    this.secret = config.secret;
    this.apiUrl = config.apiUrl || STABLE_URL;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** HMAC v2: base64(hmac_sha256(timestamp + token + resourcetype + actionid, secret)). */
  private createHmac(timestamp: number, resourcetype: string, actionId: string): string {
    const message = `${timestamp}${this.token}${resourcetype}${actionId}`;
    return createHmac("sha256", this.secret).update(message).digest("base64");
  }

  private buildAction(action: ActionInput): Record<string, unknown> {
    const actionId = resolveActionId(action.actionid);
    const resourcetype = action.resourcetype ?? "";
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      actionid: actionId,
      resourceid: action.resourceid ?? "",
      identifier: action.identifier ?? "",
      resourcetype,
      timestamp,
      hmac: this.createHmac(timestamp, resourcetype, actionId),
      hmac_version: "2",
      parameters: action.parameters ?? {},
    };
  }

  async call(
    actions: ActionInput | ActionInput[],
    signal?: AbortSignal,
  ): Promise<OnOfficeResponse> {
    const list = Array.isArray(actions) ? actions : [actions];
    const readOnly = list.every((a) => {
      const urn = resolveActionId(a.actionid);
      return urn === ACTION_URN.read || urn === ACTION_URN.get;
    });
    const maxAttempts = readOnly ? MAX_READ_ATTEMPTS : 1;
    const summary = list.map((a) => `${a.actionid}:${a.resourcetype}`);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(list, signal);
      } catch (error) {
        const retryable =
          error instanceof TransientError && attempt < maxAttempts && !signal?.aborted;
        if (!retryable) {
          log.error({ err: error, actions: summary, attempt }, "onOffice request failed");
          throw error;
        }
        log.warn({ err: error, actions: summary, attempt }, "onOffice request failed, retrying");
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
        if (signal?.aborted) throw error;
      }
    }
  }

  /**
   * One HTTP attempt. Actions are rebuilt here so every retry signs with a fresh
   * timestamp; a signature from before a backoff pause could drift outside
   * onOffice's HMAC timestamp tolerance.
   */
  private async attempt(list: ActionInput[], signal?: AbortSignal): Promise<OnOfficeResponse> {
    const body = {
      token: this.token,
      request: { actions: list.map((a) => this.buildAction(a)) },
    };
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);

    let res: Response;
    let text: string;
    try {
      res = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      text = await res.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadline.aborted) {
        throw new TransientError(`onOffice API request timed out after ${this.requestTimeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientError(`onOffice API request failed: ${message}`, { cause: error });
    }

    let parsed: OnOfficeResponse;
    try {
      parsed = JSON.parse(text) as OnOfficeResponse;
    } catch {
      const message = `onOffice API returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`;
      throw isTransientStatus(res.status) ? new TransientError(message) : new Error(message);
    }

    // Rate limits and server errors are transient even with a parseable
    // envelope; other HTTP failures are checked after assertOk, so an
    // envelope-level message wins over a bare status code.
    if (isTransientStatus(res.status)) {
      throw new TransientError(
        `onOffice API error (HTTP ${res.status}): ${parsed.status?.message ?? "transient failure"}`,
      );
    }
    assertOk(parsed);
    if (!res.ok) {
      throw new Error(`onOffice API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }
    return parsed;
  }

  action(
    action: ActionType | string,
    resourcetype: string,
    opts: Omit<ActionInput, "actionid" | "resourcetype"> = {},
    signal?: AbortSignal,
  ): Promise<OnOfficeResponse> {
    return this.call({ actionid: action, resourcetype, ...opts }, signal);
  }
}

export interface OnOfficeActionResponse {
  actionid?: string;
  resourceid?: string;
  resourcetype?: string;
  cacheable?: boolean;
  identifier?: string;
  data?: {
    meta?: { cntabsolute?: number | null; [k: string]: unknown };
    records?: Array<{ id?: string; type?: string; elements?: Record<string, unknown> }>;
    [k: string]: unknown;
  };
  status?: { errorcode?: number; message?: string };
}

export interface OnOfficeResponse {
  status?: { code?: number; errorcode?: number; message?: string };
  response?: { results?: OnOfficeActionResponse[] };
}

export function resultsOf(resp: OnOfficeResponse): OnOfficeActionResponse[] {
  return resp.response?.results ?? [];
}

class TransientError extends Error {}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

function assertOk(resp: OnOfficeResponse): void {
  const top = resp.status;
  const topFailed =
    top !== undefined &&
    ((typeof top.code === "number" && top.code >= 300) ||
      (typeof top.errorcode === "number" && top.errorcode !== 0));
  if (topFailed) {
    throw new Error(
      `onOffice API error (status ${top.code ?? "?"}${top.errorcode ? `/${top.errorcode}` : ""}): ${top.message ?? "unknown error"}`,
    );
  }
  const failed = resultsOf(resp).filter(
    (r) => r.status && typeof r.status.errorcode === "number" && r.status.errorcode !== 0,
  );
  if (failed.length > 0) {
    const msgs = failed
      .map((r) => `[${r.status?.errorcode}] ${r.status?.message ?? "error"}`)
      .join("; ");
    throw new Error(`onOffice action error: ${msgs}`);
  }
}
