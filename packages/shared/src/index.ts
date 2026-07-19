import type { AgentCard, EmailRef } from "./cards.js";

export * from "./cards.js";
export * from "./onoffice.js";
export * from "./whatsapp.js";

export const EMAIL_APPS = ["gmail", "microsoft_outlook", "zoho_mail", "imap"] as const;
export type EmailApp = (typeof EMAIL_APPS)[number];

export const EMAIL_APP_LABELS: Record<EmailApp, string> = {
  gmail: "Gmail",
  microsoft_outlook: "Outlook / Exchange (Microsoft 365)",
  zoho_mail: "Zoho Mail",
  imap: "IMAP (any other provider)",
};

export const POPULAR_APPS = [
  "notion",
  "slack_bot",
  "google_calendar",
  "google_drive",
  "github",
  "todoist",
] as const;

export interface PipedreamApp {
  slug: string;
  name: string;
  imgSrc?: string;
}

export const SUPPORTED_LANGUAGES = ["en", "de"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  de: "Deutsch",
};

export const LANGUAGE_ENGLISH_NAMES: Record<Language, string> = {
  en: "English",
  de: "German",
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export type ApiErrorCode = "pipedream_not_configured";

export interface PipedreamStatus {
  configured: boolean;
  /** "custom" = the user's own Pipedream project; "builtin" = shipped with the app. */
  mode: "custom" | "builtin";
  builtinAvailable: boolean;
  source: "settings" | "env" | null;
  clientId: string | null;
  projectId: string | null;
  environment: "development" | "production";
  /** True when a client secret is stored; the secret itself is never returned. */
  hasClientSecret: boolean;
}

/** clientSecret may be omitted to keep the saved one. */
export interface PipedreamConfigInput {
  clientId: string;
  clientSecret?: string;
  project: string;
  environment?: "development" | "production";
}

export interface ConnectedAccount {
  id: string;
  app: string;
  appName?: string;
  imgSrc?: string;
  name: string;
  healthy: boolean;
  createdAt: string;
}

export interface AccountColor {
  accountId: string;
  hex: string;
}

/** Reading is always allowed; an account with no record is read-only. */
export interface AccountPermissions {
  accountId: string;
  /** Every non-read verb not covered by send/delete. */
  write: boolean;
  /** Outward communication: send, reply, forward, publish. */
  send: boolean;
  /** Destructive verbs: delete, remove, trash, destroy, purge. */
  delete: boolean;
}

/**
 * Each switch arms one whole-filesystem capability; nothing armed = no file
 * access. Paths start in the user's home directory; interactive sessions only.
 */
export interface FileAccessSettings {
  read: boolean;
  write: boolean;
  bash: boolean;
}

/** Writing style is NOT a field here: style directives live as account-scoped memories. */
export interface AccountVoice {
  accountId: string;
  learnedAt?: string;
  styleMemoryIds?: string[];
}

export interface SearchResult {
  type: "chat" | "run" | "draft" | "document" | "memory";
  /** conversationId | run id | draft id | document id | memory id, per `type`. */
  id: string;
  title: string;
  snippet: string;
  date?: string;
  accountId?: string;
}

export interface ConnectTokenResponse {
  token: string;
  connectLinkUrl: string;
  expiresAt: string;
  externalUserId: string;
}

export interface Conversation {
  id: string;
  title: string;
  type?: "chat" | "automation";
  createdAt: string;
  running?: boolean;
  focusAccountId?: string | null;
  focusThreadId?: string | null;
  focusThreadSubject?: string | null;
}

export interface ChatToolCall {
  id: string;
  name: string;
  label?: string;
  isError: boolean;
  done: boolean;
  detail?: string;
  parameters?: unknown;
  result?: unknown;
  contentOffset?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  cards?: MessageCard[];
  toolCalls?: ChatToolCall[];
  refs?: EmailRef[];
  error?: string;
}

export interface MessageCard {
  toolCallId: string;
  card: AgentCard;
}

export interface Automation {
  id: string;
  name: string;
  instruction: string;
  /** 5-field cron expression; "" = manual-only ("Run now"). */
  schedule: string;
  enabled: boolean;
  showInActivity: boolean;
  /** At most one automation may be pinned; its latest successful run leads Home. */
  pinned: boolean;
  /** Lead this automation belongs to, deleted with it; null for standalone. */
  leadId: string | null;
  runOnNewMail: boolean;
  notifyOnCompletion: boolean;
  createdAt: string;
  nextRunAt?: string | null;
}

export interface AutomationSuggestion {
  id: string;
  name: string;
  instruction: string;
  schedule: string;
  rationale: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  decidedAt: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: "running" | "success" | "error";
  result: string;
  startedAt: string;
  finishedAt: string | null;
  cards?: MessageCard[];
}

export interface RunFeedItem extends AutomationRun {
  automationName: string | null;
}

/** Only the latest missed slot is reported per automation, not one per skipped occurrence. */
export interface MissedAutomation {
  id: string;
  name: string;
  dueAt: string;
}

export type LeadSource = "email" | "manual" | "onoffice";

/** Sales priority tier from purchase likelihood: A hot, B warm, C cold; "" unassessed. */
export type LeadPriority = "A" | "B" | "C" | "";

/**
 * Lifecycle: new = no outreach yet; contacted = we wrote, awaiting reply;
 * engaged = they replied; qualified = serious prospect; won/lost close it.
 */
export type LeadStatus = "new" | "contacted" | "engaged" | "qualified" | "won" | "lost";

/**
 * Keyed by normalized email: repeat interest updates the row instead of
 * duplicating it. Follow-up automations reference it via Automation.leadId and
 * are deleted with it.
 */
export interface Lead {
  id: string;
  name: string;
  /** Normalized (lowercased) address; the lead's unique identity. */
  email: string;
  phone: string;
  accountId: string;
  source: LeadSource;
  onofficeAddressId: string | null;
  status: LeadStatus;
  interest: string;
  persona: string;
  /** Priority tier A/B/C the caller acts on before first contact. */
  priority: LeadPriority;
  /** Detected inquiry language (BCP-47 primary subtag, e.g. "de"), for the caller. */
  language: string;
  notes: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDraft {
  id: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  date: string;
  webUrl: string;
  conversationId?: string;
  snippet?: string;
}

export interface AccountDrafts {
  account: string;
  accountId: string;
  drafts: EmailDraft[];
  error?: string;
}

export interface LlmProviderInfo {
  id: string;
  name: string;
  oauth: boolean;
  oauthName?: string;
  auth: "subscription" | "stored_key" | "env" | null;
  authDetail?: string;
  modelCount: number;
}

export interface LoginFlowStatus {
  providerId: string | null;
  providerName?: string;
  authUrl?: string;
  instructions?: string;
  deviceCode?: { userCode: string; verificationUri: string };
  prompt?: { message: string; placeholder?: string };
  select?: { message: string; options: { id: string; label: string }[] };
  done: boolean;
  error?: string;
}

export interface ModelSettings {
  provider: string;
  model: string;
  catalog: { id: string; name: string; models: string[] }[];
}

export interface AppStatus {
  pipedreamConfigured: boolean;
  modelConfigured: boolean;
  emailAccounts: number;
  /**
   * True when `emailAccounts` is a real answer: the list was fetched, or
   * Pipedream isn't configured at all. False only when Pipedream IS configured
   * but listing accounts failed (a transient outage, not a setup problem).
   */
  emailAccountsKnown: boolean;
  /**
   * The whole lead surface (leads page, lead tools, the seeded lead
   * automations) exists only when this is true.
   */
  onofficeConfigured: boolean;
  provider: string;
  model: string;
}

/** Usable once the model has credentials and an email account is linked; an
 *  unknown account count (provider unreachable) never counts as incomplete,
 *  only a confirmed zero. */
export function isSetupComplete(status: AppStatus): boolean {
  return status.modelConfigured && (status.emailAccounts > 0 || !status.emailAccountsKnown);
}

/** Longest a memory's content may be; entries are injected into the prompt in full. */
export const MEMORY_MAX_LENGTH = 300;

/** Hard cap on stored memory entries; every one is injected into the prompt. */
export const MEMORY_MAX_COUNT = 200;

/**
 * Scope is one of three states: global (accountId and contactId both null),
 * account-scoped, or contact-scoped, never both set.
 */
export interface MemoryEntry {
  id: string;
  content: string;
  /** "user" = added in Settings; "agent" = saved by the assistant. */
  source: "user" | "agent";
  /** Account this fact is scoped to; null = not account-scoped. */
  accountId: string | null;
  /** Normalized (lowercased) email this fact is about; null = not contact-scoped. */
  contactId: string | null;
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SKILL_MAX_LENGTH = 10_000;

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  updatedAt: string;
}

export interface LearnRun {
  id: string;
  /** "boot" = catch-up sweep after server start; "scheduled" = the nightly run. */
  reason: "boot" | "scheduled";
  status: "ok" | "error";
  matched: number;
  pending: number;
  /** Pairs stamped learned without a lesson: the draft was sent unchanged. */
  identical: number;
  learned: number;
  lessons: number;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface LearnStatus {
  runs: LearnRun[];
  nextRunAt: string | null;
}

/**
 * One record per account, overwritten on retry; "error" stays until a rerun
 * succeeds, so a failed or skipped learn stays visible and retryable.
 */
export interface VoiceLearnRun {
  accountId: string;
  status: "running" | "ok" | "error";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LibraryDocument {
  id: string;
  /** Path relative to the library folder. */
  path: string;
  title: string;
  ext: string;
  size: number;
  status: "indexed" | "error";
  error: string | null;
  chunkCount: number;
  textLength: number;
  modifiedAt: string;
  indexedAt: string;
}

export interface LibraryStatus {
  folder: string;
  /** Every directory under the knowledge folder (relative paths), empty ones included. */
  folders: string[];
  documents: LibraryDocument[];
}

export interface LibrarySearchHit {
  id: string;
  title: string;
  path: string;
  ext: string;
  snippet: string;
}

/** Raw file text of an editable (md/txt) library document, for the web editor. */
export interface LibraryDocumentContent {
  content: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface CreatedDraft {
  draftId: string;
  messageId: string;
  threadId: string;
  webUrl: string;
}

export type TodoStatus = "open" | "done" | "dismissed";

export interface TodoStep {
  id: string;
  label: string;
  done: boolean;
}

/**
 * A human-attention item the agent surfaces and maintains: something you must
 * do or decide, with an optional checklist of steps. The async, persistent
 * counterpart of the in-chat `choices` card. Distinct from an automation (that
 * is agent-executed); a run creates a todo when it needs a human.
 */
export interface Todo {
  id: string;
  title: string;
  body: string;
  status: TodoStatus;
  /** When the user should do/decide this; null = undated ("anytime"). The home agenda groups and sorts on it. */
  dueAt: string | null;
  /** Conversation/run that created it, for "open in chat"; null when none. */
  conversationId: string | null;
  steps: TodoStep[];
  createdAt: string;
  updatedAt: string;
}

export type ServerEventTopic =
  | "runs"
  | "drafts"
  | "todos"
  | "memories"
  | "skills"
  | "library"
  | "conversations"
  | "automations"
  | "learn"
  | "leads"
  | "whatsapp"
  | "accounts"
  | "notification";

export interface RunNotification {
  runId: string;
  automationId: string;
  automationName: string;
  status: "success" | "error";
  summary: string;
}

export interface ServerEvent {
  topic: ServerEventTopic;
  notification?: RunNotification;
}

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking" }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      toolLabel: string;
      parameters?: unknown;
      contentOffset: number;
    }
  | { type: "tool_update"; toolCallId: string; toolName: string; detail: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result?: unknown }
  | { type: "card"; toolCallId: string; card: AgentCard }
  | { type: "done"; text: string }
  | { type: "error"; message: string };
