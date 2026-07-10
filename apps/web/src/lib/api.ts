import type {
  AccountColor,
  AccountDescription,
  AccountDrafts,
  AccountVoice,
  AccountWaiting,
  AppStatus,
  Automation,
  AutomationRun,
  ChatMessage,
  ChatStreamEvent,
  ConnectedAccount,
  ConnectTokenResponse,
  Conversation,
  EmailThread,
  Language,
  LibraryStatus,
  LlmProviderInfo,
  LoginFlowStatus,
  MemoryEntry,
  ModelSettings,
  PipedreamApp,
  PipedreamConfigInput,
  PipedreamStatus,
  RunFeedItem,
  SearchResult,
} from "@trailin/shared";

/** One document match from GET /api/library/search. */
export interface LibrarySearchHit {
  id: string;
  title: string;
  path: string;
  ext: string;
  snippet: string;
}

/** Throws with the server's `error` message when a response is not ok. */
async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  let message = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // keep the status text
  }
  throw new Error(message);
}

/** Fetch JSON; non-2xx responses throw with the server's `error` message. */
async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
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

  emailWrite: () => get<{ allowWrite: boolean }>("/api/settings/email-write"),
  setEmailWrite: (allowWrite: boolean) =>
    http<{ allowWrite: boolean }>("PUT", "/api/settings/email-write", { allowWrite }),

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
  // Long-running (30-90s): the server reads the account's sent mail and derives
  // a signature + style notes.
  learnAccountVoice: (accountId: string) =>
    http<{ voice: AccountVoice }>(
      "POST",
      `/api/settings/account-voices/${encodeURIComponent(accountId)}/learn`,
    ),

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
  llmLogout: (providerId: string) => http<{ ok: boolean }>("POST", "/api/llm/logout", { providerId }),

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
    http<{ ok: boolean }>("DELETE", `/api/pipedream/accounts/${id}`),

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
  pinnedRun: () => get<{ run: RunFeedItem | null; automation: Automation | null }>("/api/runs/pinned"),
  drafts: (opts?: { refresh?: boolean }) =>
    get<AccountDrafts[]>(`/api/drafts${opts?.refresh ? "?refresh=1" : ""}`),
  draftDetail: (accountId: string, draftId: string) =>
    get<{ body: string; cc: string; bcc: string }>(`/api/drafts/${accountId}/${draftId}`),
  deleteDraft: (accountId: string, draftId: string) =>
    http<{ ok: boolean }>("DELETE", `/api/drafts/${accountId}/${draftId}`),
  // No humanizer/signature — saves exactly what the caller passed.
  updateDraft: (accountId: string, draftId: string, patch: { body?: string; subject?: string }) =>
    http<{ ok: boolean }>("PATCH", `/api/drafts/${accountId}/${draftId}`, patch),
  /** `excludeMessageId` drops the draft's own message — Gmail counts it as part of the thread. */
  draftThread: (accountId: string, threadId: string, excludeMessageId?: string) =>
    get<EmailThread>(
      `/api/threads/${accountId}/${threadId}${
        excludeMessageId ? `?excludeMessageId=${encodeURIComponent(excludeMessageId)}` : ""
      }`,
    ),
  waiting: () => get<AccountWaiting[]>("/api/waiting"),

  conversations: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const qs = search.toString();
    return get<{ items: Conversation[]; total: number }>(
      `/api/conversations${qs ? `?${qs}` : ""}`,
    );
  },
  conversationMessages: (id: string) =>
    get<ChatMessage[]>(`/api/conversations/${encodeURIComponent(id)}/messages`),
  systemPrompt: () => get<{ prompt: string }>("/api/chat/system-prompt"),
  renameConversation: (id: string, title: string) =>
    http<{ ok: boolean }>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { title }),
  deleteConversation: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/conversations/${encodeURIComponent(id)}`),

  automations: () => get<Automation[]>("/api/automations"),
  createAutomation: (body: { name: string; instruction: string; schedule: string; showInActivity?: boolean }) =>
    http<Automation>("POST", "/api/automations", body),
  updateAutomation: (id: string, body: Partial<Automation>) =>
    http<Automation>("PATCH", `/api/automations/${id}`, body),
  // Setting pinned true unpins every other automation server-side (exactly one may lead Home).
  setAutomationPinned: (id: string, pinned: boolean) =>
    http<Automation>("PATCH", `/api/automations/${id}`, { pinned }),
  deleteAutomation: (id: string) => http<{ ok: boolean }>("DELETE", `/api/automations/${id}`),
  runAutomation: (id: string) => http<{ ok: boolean }>("POST", `/api/automations/${id}/run`),
  automationRuns: (id: string) => get<AutomationRun[]>(`/api/automations/${id}/runs`),

  memories: () => get<MemoryEntry[]>("/api/memories"),
  // `accountId` is only sent when the caller passes it explicitly — omitting it
  // must not appear in the JSON body, so the server keeps the entry's current scope.
  addMemory: (content: string, accountId?: string | null) =>
    http<MemoryEntry>(
      "POST",
      "/api/memories",
      accountId !== undefined ? { content, accountId } : { content },
    ),
  updateMemory: (id: string, content: string, accountId?: string | null) =>
    http<MemoryEntry>(
      "PUT",
      `/api/memories/${id}`,
      accountId !== undefined ? { content, accountId } : { content },
    ),
  deleteMemory: (id: string) => http<{ ok: boolean }>("DELETE", `/api/memories/${id}`),

  library: () => get<LibraryStatus>("/api/library"),
  setLibraryFolder: (folder: string) =>
    http<LibraryStatus>("PUT", "/api/library/folder", { folder }),
  // Opens the OS's native folder dialog on the server's machine; the request
  // stays open until the user picks (fresh status) or dismisses the dialog.
  pickLibraryFolder: () =>
    http<LibraryStatus | { canceled: true }>("POST", "/api/library/folder/pick"),
  deleteLibraryDocument: (id: string) =>
    http<LibraryStatus>("DELETE", `/api/library/documents/${id}`),
  searchLibrary: (q: string) =>
    get<{ results: LibrarySearchHit[] }>(`/api/library/search?q=${encodeURIComponent(q)}`),
  // Raw file body (not JSON), so this bypasses the `http` helper.
  uploadLibraryFile: async (file: File): Promise<LibraryStatus> => {
    const res = await fetch(`/api/library/files?name=${encodeURIComponent(file.name)}`, {
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
};

/**
 * POST /api/chat and iterate the SSE stream. Calls onEvent for every event;
 * resolves when the stream closes.
 */
export async function streamChat(
  body: { conversationId?: string; message: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
