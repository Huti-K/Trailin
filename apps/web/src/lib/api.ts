import type {
  AccountColor,
  AccountDescription,
  AccountDrafts,
  AccountVoice,
  ApiErrorCode,
  AppStatus,
  Automation,
  AutomationRun,
  ChatMessage,
  ChatStreamEvent,
  ConnectedAccount,
  ConnectTokenResponse,
  Contact,
  ContactCategory,
  ContactDetail,
  ContactKind,
  Conversation,
  EmailRef,
  EmailThread,
  Language,
  LibraryStatus,
  LlmProviderInfo,
  LoginFlowStatus,
  MailSuggestion,
  MemoryEntry,
  ModelSettings,
  NewsletterSender,
  OpenConversations,
  PipedreamApp,
  PipedreamConfigInput,
  PipedreamStatus,
  RunFeedItem,
  SearchResult,
  UnsubscribeResult,
} from "@trailin/shared";
import i18n from "@/lib/i18n";

/** One document match from GET /api/library/search. */
export interface LibrarySearchHit {
  id: string;
  title: string;
  path: string;
  ext: string;
  snippet: string;
}

/** A draft's recorded fate, from GET /api/drafts/:accountId/:draftId/status. */
export interface DraftStatusResult {
  status: "open" | "sent" | "discarded";
  sentMessageId?: string;
}

/**
 * A failed API call. `status` is the raw HTTP status (callers use it to tell
 * a 404 — "gone upstream" — apart from other failures without matching
 * message text). `code` is the server's machine-readable hint for
 * user-fixable failures — the toast layer maps it to a click-through action
 * (see lib/toast.ts); it's undefined for everything else.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True for a failed request the server answered with 404 (the resource is gone). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Plain-language message for an HTTP status class. */
function statusMessage(status: number): string {
  if (status === 401 || status === 403) return i18n.t("errors.forbidden");
  if (status === 404) return i18n.t("errors.notFound");
  if (status === 408 || status === 504) return i18n.t("errors.timeout");
  if (status === 502 || status === 503) return i18n.t("errors.unavailable");
  if (status >= 500) return i18n.t("errors.server");
  return i18n.t("errors.request");
}

/**
 * Throws when a response is not ok — with the server's `error` message when
 * the body carries one, otherwise a plain-language message for the status
 * class. Raw status codes go to the console, never to the user.
 */
async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  console.error(`API ${res.status} ${res.statusText}: ${res.url}`);
  let message = statusMessage(res.status);
  let code: ApiErrorCode | undefined;
  try {
    const data = (await res.json()) as { error?: string; code?: ApiErrorCode };
    if (data.error) message = data.error;
    code = data.code;
  } catch {
    // no JSON envelope — keep the status-class message
  }
  throw new ApiError(message, res.status, code);
}

/**
 * fetch that rethrows connection failures as a plain-language error (the raw
 * cause goes to the console). Aborts pass through untouched so callers can
 * keep telling cancellation apart from failure.
 */
async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.error(`API request failed: ${url}`, err);
    throw new Error(i18n.t("errors.network"));
  }
}

/** Fetch JSON; non-2xx responses throw with a user-facing message. */
async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await guardedFetch(url, {
    method,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  await throwOnError(res);
  return res.json() as Promise<T>;
}

const get = <T>(url: string) => http<T>("GET", url);

export const api = {
  status: () => get<AppStatus>("/api/status"),

  // null until a language has been chosen (first web load initializes it).
  language: () => get<{ language: Language | null }>("/api/settings/language"),
  setLanguage: (language: Language) =>
    http<{ language: Language }>("PUT", "/api/settings/language", { language }),

  // null until a timezone has been chosen (first web load initializes it).
  timezone: () => get<{ timezone: string | null }>("/api/settings/timezone"),
  setTimezone: (timezone: string) =>
    http<{ timezone: string }>("PUT", "/api/settings/timezone", { timezone }),

  syncBackfillDays: () => get<{ days: number }>("/api/settings/sync-backfill-days"),
  setSyncBackfillDays: (days: number) =>
    http<{ days: number }>("PUT", "/api/settings/sync-backfill-days", { days }),

  contactThreadsLimit: () => get<{ limit: number }>("/api/settings/contact-threads-limit"),
  setContactThreadsLimit: (limit: number) =>
    http<{ limit: number }>("PUT", "/api/settings/contact-threads-limit", { limit }),

  writeAccess: () => get<{ accountIds: string[] }>("/api/settings/write-access"),
  setWriteAccess: (accountIds: string[]) =>
    http<{ accountIds: string[] }>("PUT", "/api/settings/write-access", { accountIds }),

  accountColors: () => get<{ colors: AccountColor[] }>("/api/settings/account-colors"),
  setAccountColors: (colors: AccountColor[]) =>
    http<{ colors: AccountColor[] }>("PUT", "/api/settings/account-colors", { colors }),
  accountDescriptions: () =>
    get<{ descriptions: AccountDescription[] }>("/api/settings/account-descriptions"),
  setAccountDescriptions: (descriptions: AccountDescription[]) =>
    http<{ descriptions: AccountDescription[] }>("PUT", "/api/settings/account-descriptions", {
      descriptions,
    }),
  accountVoices: () => get<{ voices: AccountVoice[] }>("/api/settings/account-voices"),
  saveAccountVoices: (voices: AccountVoice[]) =>
    http<{ voices: AccountVoice[] }>("PUT", "/api/settings/account-voices", { voices }),

  llmProviders: () => get<LlmProviderInfo[]>("/api/llm/providers"),
  modelSettings: () => get<ModelSettings>("/api/llm/model"),
  setModel: (provider: string, model: string) =>
    http<ModelSettings>("PUT", "/api/llm/model", { provider, model }),
  loginStatus: () => get<LoginFlowStatus>("/api/llm/login/status"),
  loginStart: (providerId: string) =>
    http<LoginFlowStatus>("POST", "/api/llm/login/start", { providerId }),
  loginInput: (value: string) => http<{ ok: boolean }>("POST", "/api/llm/login/input", { value }),
  loginSelect: (optionId: string) =>
    http<{ ok: boolean }>("POST", "/api/llm/login/select", { optionId }),
  loginCancel: () => http<{ ok: boolean }>("POST", "/api/llm/login/cancel"),
  saveApiKey: (providerId: string, apiKey: string) =>
    http<{ ok: boolean }>("POST", "/api/llm/key", { providerId, apiKey }),
  llmLogout: (providerId: string) =>
    http<{ ok: boolean }>("POST", "/api/llm/logout", { providerId }),

  pipedreamStatus: () => get<PipedreamStatus>("/api/pipedream"),
  savePipedream: (body: PipedreamConfigInput) =>
    http<PipedreamStatus>("PUT", "/api/pipedream", body),
  clearPipedream: () => http<PipedreamStatus>("DELETE", "/api/pipedream"),
  setPipedreamMode: (useCustom: boolean) =>
    http<PipedreamStatus>("PUT", "/api/pipedream/mode", { useCustom }),
  pipedreamAccounts: () => get<ConnectedAccount[]>("/api/pipedream/accounts"),
  pipedreamApps: (q: string) =>
    get<PipedreamApp[]>(`/api/pipedream/apps?q=${encodeURIComponent(q)}`),
  pipedreamConnectToken: (app: string) =>
    http<ConnectTokenResponse>("POST", "/api/pipedream/accounts/connect-token", { app }),
  deletePipedreamAccount: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/pipedream/accounts/${encodeURIComponent(id)}`),

  /** Global search across chats, digests, drafts, documents and memories (command palette). */
  search: (q: string) => get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`),

  runsFeed: (params?: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ items: RunFeedItem[]; total: number }>(`/api/runs${suffix}`);
  },
  // The pinned automation's latest successful run, for the Home page lead card.
  // Unlike runsFeed, never filtered by showInActivity and never paginated away.
  pinnedRun: () =>
    get<{ run: RunFeedItem | null; automation: Automation | null }>("/api/runs/pinned"),
  drafts: (opts?: { refresh?: boolean }) =>
    get<AccountDrafts[]>(`/api/drafts${opts?.refresh ? "?refresh=1" : ""}`),
  draftDetail: (accountId: string, draftId: string) =>
    get<{ body: string; cc: string; bcc: string }>(
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}`,
    ),
  deleteDraft: (accountId: string, draftId: string) =>
    http<{ ok: boolean }>(
      "DELETE",
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}`,
    ),
  // No humanizer/signature — saves exactly what the caller passed.
  updateDraft: (accountId: string, draftId: string, patch: { body?: string; subject?: string }) =>
    http<{ ok: boolean }>(
      "PATCH",
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}`,
      patch,
    ),
  // Human-initiated only — sends the draft as it currently stands upstream.
  sendDraft: (accountId: string, draftId: string) =>
    http<{ ok: boolean }>(
      "POST",
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}/send`,
    ),
  // 404 means no snapshot exists (the draft wasn't agent-written) — callers
  // treat that the same as any other failure to load a status.
  draftStatus: (accountId: string, draftId: string) =>
    get<DraftStatusResult>(
      `/api/drafts/${encodeURIComponent(accountId)}/${encodeURIComponent(draftId)}/status`,
    ),
  /** `excludeMessageId` drops the draft's own message — Gmail counts it as part of the thread. */
  draftThread: (accountId: string, threadId: string, excludeMessageId?: string) =>
    get<EmailThread>(
      `/api/threads/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}${
        excludeMessageId ? `?excludeMessageId=${encodeURIComponent(excludeMessageId)}` : ""
      }`,
    ),
  waiting: () => get<OpenConversations>("/api/waiting"),
  // Removes one thread from the "waiting on you" lane until a new inbound message revives it.
  dismissWaiting: (accountId: string, threadId: string) =>
    http<{ ok: boolean }>(
      "POST",
      `/api/waiting/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/dismiss`,
    ),

  /** The composer's @-mention search — empty `q` returns recent threads instead of no results. */
  mailSuggest: (q: string, limit?: number) => {
    const search = new URLSearchParams({ q });
    if (limit !== undefined) search.set("limit", String(limit));
    return get<{ items: MailSuggestion[] }>(`/api/mail/suggest?${search.toString()}`);
  },

  conversations: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const qs = search.toString();
    return get<{ items: Conversation[]; total: number }>(`/api/conversations${qs ? `?${qs}` : ""}`);
  },
  conversationMessages: (id: string) =>
    get<ChatMessage[]>(`/api/conversations/${encodeURIComponent(id)}/messages`),
  systemPrompt: () => get<{ prompt: string }>("/api/chat/system-prompt"),
  renameConversation: (id: string, title: string) =>
    http<{ ok: boolean }>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { title }),
  // A string sets focus to that account (the server clears the thread part);
  // null removes focus entirely.
  setConversationFocus: (id: string, focusAccountId: string | null) =>
    http<{ ok: boolean }>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, {
      focusAccountId,
    }),
  deleteConversation: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/conversations/${encodeURIComponent(id)}`),

  automations: () => get<Automation[]>("/api/automations"),
  createAutomation: (body: {
    name: string;
    instruction: string;
    schedule: string;
    showInActivity?: boolean;
  }) => http<Automation>("POST", "/api/automations", body),
  updateAutomation: (id: string, body: Partial<Automation>) =>
    http<Automation>("PATCH", `/api/automations/${encodeURIComponent(id)}`, body),
  // Setting pinned true unpins every other automation server-side (exactly one may lead Home).
  setAutomationPinned: (id: string, pinned: boolean) =>
    http<Automation>("PATCH", `/api/automations/${encodeURIComponent(id)}`, { pinned }),
  deleteAutomation: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/automations/${encodeURIComponent(id)}`),
  runAutomation: (id: string) =>
    http<{ ok: boolean }>("POST", `/api/automations/${encodeURIComponent(id)}/run`),
  automationRuns: (id: string) =>
    get<AutomationRun[]>(`/api/automations/${encodeURIComponent(id)}/runs`),

  memories: () => get<MemoryEntry[]>("/api/memories"),
  // accountId/contactId are only sent when the caller passes them explicitly —
  // an omitted axis stays out of the JSON body, so on updates the server keeps
  // that axis (or clears it when the other axis is being set — a memory
  // carries at most one of the two; see db/memories.ts). Creates default both
  // to global.
  addMemory: (content: string, accountId?: string | null, contactId?: string | null) =>
    http<MemoryEntry>("POST", "/api/memories", {
      content,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(contactId !== undefined ? { contactId } : {}),
    }),
  updateMemory: (
    id: string,
    content: string,
    accountId?: string | null,
    contactId?: string | null,
  ) =>
    http<MemoryEntry>("PUT", `/api/memories/${encodeURIComponent(id)}`, {
      content,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(contactId !== undefined ? { contactId } : {}),
    }),
  deleteMemory: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/memories/${encodeURIComponent(id)}`),

  /** Mailbox-derived correspondents (see email/contacts/) — one row per address. */
  contacts: (params: { kind?: ContactKind; category?: ContactCategory; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set("kind", params.kind);
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<Contact[]>(`/api/contacts${suffix}`);
  },
  contactDetail: (address: string) =>
    get<ContactDetail>(`/api/contacts/${encodeURIComponent(address)}`),
  // The one manual override the Contacts page can make — pins category_source
  // to "user" server-side so a later enrichment pass never reverts it.
  setContactCategory: (address: string, category: ContactCategory) =>
    http<Contact>("PATCH", `/api/contacts/${encodeURIComponent(address)}`, { category }),

  /** Bulk/newsletter senders (contacts rows with kind="bulk") and their unsubscribe state. */
  newsletters: () => get<NewsletterSender[]>("/api/newsletters"),
  unsubscribeNewsletter: (address: string, accountId: string) =>
    http<UnsubscribeResult>("POST", "/api/newsletters/unsubscribe", { address, accountId }),

  library: () => get<LibraryStatus>("/api/library"),
  setLibraryFolder: (folder: string) =>
    http<LibraryStatus>("PUT", "/api/library/folder", { folder }),
  // Opens the OS's native folder dialog on the server's machine; the request
  // stays open until the user picks (fresh status) or dismisses the dialog.
  pickLibraryFolder: () =>
    http<LibraryStatus | { canceled: true }>("POST", "/api/library/folder/pick"),
  deleteLibraryDocument: (id: string) =>
    http<LibraryStatus>("DELETE", `/api/library/documents/${encodeURIComponent(id)}`),
  searchLibrary: (q: string) =>
    get<{ results: LibrarySearchHit[] }>(`/api/library/search?q=${encodeURIComponent(q)}`),
  // Raw file body (not JSON), so this bypasses the `http` helper.
  uploadLibraryFile: async (file: File): Promise<LibraryStatus> => {
    const res = await guardedFetch(`/api/library/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    await throwOnError(res);
    return res.json() as Promise<LibraryStatus>;
  },
  /** Open a library document in a new browser tab (or trigger a download). */
  openLibraryDocument: (id: string): void => {
    window.open(`/api/library/documents/${encodeURIComponent(id)}/open`, "_blank");
  },
  /** Download a SQLite snapshot of the local database (streamed as an attachment). */
  downloadBackup: (): void => {
    window.open("/api/backup", "_blank");
  },
};

/**
 * POST /api/chat and iterate the SSE stream. Calls onEvent for every event;
 * resolves when the stream closes.
 */
export async function streamChat(
  body: { conversationId?: string; message: string; refs?: EmailRef[] },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await guardedFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  // A refused turn (e.g. 409 while this conversation is still replying) answers
  // with the plain `{ error }` envelope rather than the SSE stream.
  await throwOnError(res);
  if (!res.body) throw new Error("The chat response did not include a stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEvent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as ChatStreamEvent;
          } catch {
            throw new Error("The server sent an invalid chat event.");
          }
          if (event.type === "done" || event.type === "error") terminalEvent = true;
          onEvent(event);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (!terminalEvent) throw new Error("The chat response ended unexpectedly.");
}
