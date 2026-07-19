import type {
  AccountColor,
  AccountDrafts,
  AccountPermissions,
  ApiErrorCode,
  AppStatus,
  Automation,
  AutomationRun,
  AutomationSuggestion,
  ChatMessage,
  ChatStreamEvent,
  ConnectedAccount,
  ConnectTokenResponse,
  Conversation,
  EmailRef,
  EmailThreadMessage,
  FileAccessSettings,
  Language,
  Lead,
  LeadStatus,
  LibraryDocumentContent,
  LibrarySearchHit,
  LibraryStatus,
  LlmProviderInfo,
  LoginFlowStatus,
  MemoryEntry,
  MissedAutomation,
  ModelSettings,
  OnOfficeConfigInput,
  OnOfficeStatus,
  PipedreamApp,
  PipedreamConfigInput,
  PipedreamStatus,
  RunFeedItem,
  SearchResult,
  Skill,
  Todo,
  TodoStatus,
  VoiceLearnRun,
  WhatsAppStatus,
} from "@trailin/shared";
import i18n from "@/lib/i18n";
import { openExternal } from "@/lib/utils";

/** A draft's recorded fate, from GET /api/drafts/:accountId/:draftId/status. */
interface DraftStatusResult {
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

  accountPermissions: () => get<{ permissions: AccountPermissions[] }>("/api/settings/permissions"),
  setAccountPermissions: (permissions: AccountPermissions[]) =>
    http<{ permissions: AccountPermissions[] }>("PUT", "/api/settings/permissions", {
      permissions,
    }),

  fileAccess: () => get<{ fileAccess: FileAccessSettings }>("/api/settings/file-access"),
  setFileAccess: (fileAccess: FileAccessSettings) =>
    http<{ fileAccess: FileAccessSettings }>("PUT", "/api/settings/file-access", fileAccess),

  accountColors: () => get<{ colors: AccountColor[] }>("/api/settings/account-colors"),
  setAccountColors: (colors: AccountColor[]) =>
    http<{ colors: AccountColor[] }>("PUT", "/api/settings/account-colors", { colors }),

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
  learnAccountVoice: (id: string) =>
    http<{ ok: boolean }>("POST", `/api/pipedream/accounts/${encodeURIComponent(id)}/learn-voice`),
  // Each account's latest automatic voice-learn attempt (running/ok/error).
  voiceLearnRuns: () => get<VoiceLearnRun[]>("/api/learn/voice-runs"),

  onOfficeStatus: () => get<OnOfficeStatus>("/api/onoffice"),
  saveOnOffice: (body: OnOfficeConfigInput) => http<OnOfficeStatus>("PUT", "/api/onoffice", body),
  clearOnOffice: () => http<OnOfficeStatus>("DELETE", "/api/onoffice"),
  // Arm/disarm the CRM create tools for unattended automation runs.
  setOnOfficeAutomationCreates: (enabled: boolean) =>
    http<OnOfficeStatus>("PUT", "/api/onoffice/automation-creates", { enabled }),
  // Arm/disarm the CRM modify/delete/send tools for chat sessions.
  setOnOfficeWriteAccess: (enabled: boolean) =>
    http<OnOfficeStatus>("PUT", "/api/onoffice/write-access", { enabled }),

  whatsAppStatus: () => get<WhatsAppStatus>("/api/whatsapp"),
  // Opens the pairing socket; the QR and the final open state arrive via the
  // "whatsapp" server-event topic (refetch this status on it).
  whatsAppConnect: () => http<WhatsAppStatus>("POST", "/api/whatsapp/connect"),
  // Signs the device out and wipes the local chat mirror.
  whatsAppUnlink: () => http<WhatsAppStatus>("DELETE", "/api/whatsapp"),
  // Arm/disarm whatsapp_send_message for chat sessions.
  setWhatsAppSendAccess: (enabled: boolean) =>
    http<WhatsAppStatus>("PUT", "/api/whatsapp/send-access", { enabled }),

  // Outbound message drafts (WhatsApp and future channels). Send is
  // human-initiated only, like email's sendDraft.
  sendOutbound: (id: string) =>
    http<{ ok: boolean }>("POST", `/api/outbound/${encodeURIComponent(id)}/send`),
  discardOutbound: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/outbound/${encodeURIComponent(id)}`),
  outboundStatus: (id: string) =>
    get<{ status: "open" | "sent" | "discarded"; sentRef?: string }>(
      `/api/outbound/${encodeURIComponent(id)}/status`,
    ),

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
  // Automations whose latest scheduled slot elapsed without a covering run —
  // empty once boot catch-up has run them, so Home shows its button only when
  // catch-up couldn't.
  missedRuns: () => get<{ items: MissedAutomation[] }>("/api/runs/missed"),
  runMissed: () => http<{ started: MissedAutomation[] }>("POST", "/api/runs/catch-up"),
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
  // No humanizer — saves exactly what the caller passed.
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
    runOnNewMail?: boolean;
    notifyOnCompletion?: boolean;
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
  automationSuggestions: () => get<AutomationSuggestion[]>("/api/automations/suggestions"),
  // Accepting creates the proposed automation server-side and returns it.
  acceptAutomationSuggestion: (id: string) =>
    http<Automation>("POST", `/api/automations/suggestions/${encodeURIComponent(id)}/accept`),
  dismissAutomationSuggestion: (id: string) =>
    http<{ ok: boolean }>("POST", `/api/automations/suggestions/${encodeURIComponent(id)}/dismiss`),

  leads: (status?: LeadStatus) =>
    get<Lead[]>(`/api/leads${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  // Intake upsert: one lead per address — recording a known one merges instead
  // of duplicating, and `created` says which of the two happened.
  recordLead: (body: {
    email: string;
    name?: string;
    phone?: string;
    interest?: string;
    notes?: string;
  }) => http<{ lead: Lead; created: boolean }>("POST", "/api/leads", body),
  updateLead: (id: string, patch: Partial<Omit<Lead, "id" | "email" | "source">>) =>
    http<Lead>("PATCH", `/api/leads/${encodeURIComponent(id)}`, patch),
  // Also deletes every automation attached to the lead.
  deleteLead: (id: string) =>
    http<{ ok: boolean }>("DELETE", `/api/leads/${encodeURIComponent(id)}`),
  leadAutomations: (id: string) =>
    get<Automation[]>(`/api/leads/${encodeURIComponent(id)}/automations`),

  // The agent files and maintains todos; the web only lists them and toggles
  // steps/status. updateTodo is the one maintenance verb (see routes/todos.ts).
  todos: (status?: TodoStatus) =>
    get<Todo[]>(`/api/todos${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  updateTodo: (
    id: string,
    patch: {
      title?: string;
      body?: string;
      status?: TodoStatus;
      dueAt?: string | null;
      addSteps?: string[];
      completeSteps?: string[];
      reopenSteps?: string[];
    },
  ) => http<Todo>("PATCH", `/api/todos/${encodeURIComponent(id)}`, patch),

  // Memory/skill entries surface as files in the Knowledge browser: listed,
  // deleted, and edited there (the browser's md editor); created by the agent.
  memories: () => get<MemoryEntry[]>("/api/memories"),
  addMemory: (content: string, accountId?: string | null) =>
    http<MemoryEntry>("POST", "/api/memories", {
      content,
      ...(accountId !== undefined ? { accountId } : {}),
    }),
  // accountId/contactId are only sent when passed explicitly — an omitted axis
  // stays out of the body, so the server keeps it (or clears it when the other
  // axis is being set; a memory carries at most one of the two).
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

  skills: () => get<Skill[]>("/api/skills"),
  // Create-or-overwrite by name — the server has no separate create endpoint.
  saveSkill: (name: string, description: string, instructions: string) =>
    http<Skill>("PUT", `/api/skills/${encodeURIComponent(name)}`, { description, instructions }),
  deleteSkill: (name: string) =>
    http<{ ok: boolean }>("DELETE", `/api/skills/${encodeURIComponent(name)}`),

  library: () => get<LibraryStatus>("/api/library"),
  documentContent: (id: string) =>
    get<LibraryDocumentContent>(`/api/library/documents/${encodeURIComponent(id)}/content`),
  saveDocumentContent: (id: string, content: string) =>
    http<LibraryStatus>("PUT", `/api/library/documents/${encodeURIComponent(id)}/content`, {
      content,
    }),
  deleteLibraryDocument: (id: string) =>
    http<LibraryStatus>("DELETE", `/api/library/documents/${encodeURIComponent(id)}`),
  searchLibrary: (q: string) =>
    get<{ results: LibrarySearchHit[] }>(`/api/library/search?q=${encodeURIComponent(q)}`),
  // Raw file body (not JSON), so this bypasses the `http` helper.
  /** Uploads into the knowledge folder, or a subfolder of it when `dir` is set. */
  uploadLibraryFile: async (file: File, dir?: string): Promise<LibraryStatus> => {
    const target = dir ? `&dir=${encodeURIComponent(dir)}` : "";
    const res = await guardedFetch(
      `/api/library/files?name=${encodeURIComponent(file.name)}${target}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    await throwOnError(res);
    return res.json() as Promise<LibraryStatus>;
  },
  createLibraryFolder: (path: string) =>
    http<LibraryStatus>("POST", "/api/library/folders", { path }),
  deleteLibraryFolder: (path: string) =>
    http<LibraryStatus>("DELETE", `/api/library/folders?path=${encodeURIComponent(path)}`),
  /** Open a library document in a new browser tab (or trigger a download). */
  openLibraryDocument: (id: string): void => {
    openExternal(`/api/library/documents/${encodeURIComponent(id)}/open`);
  },
  /** One thread's conversation (drafts excluded), read live — the drafts' collapsible history. */
  threadDetail: (accountId: string, threadId: string) =>
    get<{ subject: string; messages: EmailThreadMessage[] }>(
      `/api/mail/threads?accountId=${encodeURIComponent(accountId)}` +
        `&threadId=${encodeURIComponent(threadId)}`,
    ),
  /** URL that streams an email attachment's bytes — inline for viewable types, download otherwise. */
  mailAttachmentUrl: (accountId: string, messageId: string, filename: string): string =>
    `/api/mail/attachments/open?accountId=${encodeURIComponent(accountId)}` +
    `&messageId=${encodeURIComponent(messageId)}&filename=${encodeURIComponent(filename)}`,
  /** Save an email attachment into the document library, where it is indexed. */
  saveMailAttachment: (accountId: string, messageId: string, filename: string) =>
    http<{ saved: string }>("POST", "/api/mail/attachments/save", {
      accountId,
      messageId,
      filename,
    }),
  /** Download a SQLite snapshot of the local database (streamed as an attachment). */
  downloadBackup: (): void => {
    openExternal("/api/backup");
  },
};

/**
 * POST /api/chat and iterate the SSE stream. Calls onEvent for every event;
 * resolves when the stream closes.
 */
export async function streamChat(
  body: {
    conversationId?: string;
    message: string;
    refs?: EmailRef[];
    /** Header-chip mailbox pick applied when this starts a new conversation. */
    focusAccountId?: string | null;
  },
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
