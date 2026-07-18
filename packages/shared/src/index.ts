import type { AgentCard, EmailRef } from "./cards.js";

export * from "./cards.js";
export * from "./onoffice.js";
export * from "./whatsapp.js";

/**
 * Suggested email apps, shown before the user searches the full catalog.
 * These are the mail providers Pipedream exposes as Connect apps; any other
 * app (mail or not) is a search away. `imap` is the catch-all for any other
 * mailbox that speaks IMAP.
 */
export const EMAIL_APPS = ["gmail", "microsoft_outlook", "zoho_mail", "imap"] as const;
export type EmailApp = (typeof EMAIL_APPS)[number];

export const EMAIL_APP_LABELS: Record<EmailApp, string> = {
  gmail: "Gmail",
  // Microsoft Graph — covers outlook.com and Microsoft 365 / Exchange Online.
  microsoft_outlook: "Outlook / Exchange (Microsoft 365)",
  zoho_mail: "Zoho Mail",
  imap: "IMAP (any other provider)",
};

/**
 * A small teaser of popular non-email integrations, shown under the email apps
 * so the picker makes clear Trailin connects far more than mail. The full
 * catalog (2,000+ apps) is always a search away.
 */
export const POPULAR_APPS = [
  "notion",
  "slack_bot",
  "google_calendar",
  "google_drive",
  "github",
  "todoist",
] as const;

/** One entry of Pipedream's app catalog. */
export interface PipedreamApp {
  slug: string;
  name: string;
  imgSrc?: string;
}

/** Languages the app ships translations for. */
export const SUPPORTED_LANGUAGES = ["en", "de"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Native names, for the language picker. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  de: "Deutsch",
};

/** English names, used when instructing the agent which language to answer in. */
export const LANGUAGE_ENGLISH_NAMES: Record<Language, string> = {
  en: "English",
  de: "German",
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Machine-readable hint on the API `{ error }` envelope for failures the user
 * can fix themselves in the app. The web client maps a code to a click-through
 * action on the error toast (e.g. "Open settings"); errors without a code stay
 * plain messages.
 */
export type ApiErrorCode = "pipedream_not_configured";

/** Pipedream Connect credential state, as shown in Settings. */
export interface PipedreamStatus {
  configured: boolean;
  /** "custom" = the user's own Pipedream project, "builtin" = credentials shipped with the app. */
  mode: "custom" | "builtin";
  /** True when this deployment ships built-in Pipedream credentials. */
  builtinAvailable: boolean;
  /** Where the active credentials come from: saved in the app or .env. */
  source: "settings" | "env" | null;
  clientId: string | null;
  projectId: string | null;
  environment: "development" | "production";
  /** True when a client secret is stored (the secret itself is never returned). */
  hasClientSecret: boolean;
}

/** Body of PUT /api/pipedream. clientSecret may be omitted to keep the saved one. */
export interface PipedreamConfigInput {
  clientId: string;
  clientSecret?: string;
  /** A proj_… id or any Pipedream project URL containing one. */
  project: string;
  environment?: "development" | "production";
}

/** One connected account (any app; several per app are fine). */
export interface ConnectedAccount {
  id: string;
  /** Pipedream app slug, e.g. "gmail". */
  app: string;
  /** Display name of the app, e.g. "Gmail". */
  appName?: string;
  /** App logo URL from Pipedream's catalog, for the account row icon. */
  imgSrc?: string;
  /** Usually the account's email address. */
  name: string;
  healthy: boolean;
  createdAt: string;
}

/** Persisted color assignment for a connected account. */
export interface AccountColor {
  /** Pipedream account id. */
  accountId: string;
  /** Resolved hex. */
  hex: string;
}

/**
 * Per-account permission grants for the agent's provider tools. Reading is
 * always allowed (that's what connecting an account is for); each grant arms
 * one verb-classified category of tools. An account with no record is
 * read-only.
 */
export interface AccountPermissions {
  /** Pipedream account id. */
  accountId: string;
  /** Create and change things: every non-read verb not covered by send/delete. */
  write: boolean;
  /** Outward communication: send, reply, forward, publish. */
  send: boolean;
  /** Destructive verbs: delete, remove, trash, destroy, purge. */
  delete: boolean;
}

/**
 * The agent's filesystem grants. Each switch arms one whole-filesystem
 * capability — reading files, creating/changing them, running shell
 * commands; with nothing armed the agent has no file access at all.
 * Relative paths and commands start in the user's home directory. All of it
 * applies to interactive sessions only.
 */
export interface FileAccessSettings {
  read: boolean;
  write: boolean;
  bash: boolean;
}

/**
 * Per-account voice-learn bookkeeping. Writing style is NOT a field here —
 * style directives live as account-scoped memories, learned from sent mail
 * by voiceLearn or written by the user, and reach the agent through the
 * memory section of its system prompt.
 */
export interface AccountVoice {
  /** Pipedream account id. */
  accountId: string;
  /** Set when the style was last derived from the account's sent mail. */
  learnedAt?: string;
  /** Memory ids the last voice-learn run wrote, so re-learning replaces them. */
  styleMemoryIds?: string[];
}

/** One hit from the global search (GET /api/search). */
export interface SearchResult {
  /** What the hit is; decides the icon and where clicking navigates. */
  type: "chat" | "run" | "draft" | "document" | "memory";
  /** conversationId | automation run id | draft id | document id | memory id. */
  id: string;
  title: string;
  /** Short plain-text context around the match. */
  snippet: string;
  /** ISO timestamp for ordering, when the source has one. */
  date?: string;
  /** Owning email account (draft hits), for inbox chips and navigation. */
  accountId?: string;
}

export interface ConnectTokenResponse {
  token: string;
  connectLinkUrl: string;
  expiresAt: string;
  /** Pipedream external user id; the browser Connect SDK needs it to start the flow. */
  externalUserId: string;
}

export interface Conversation {
  id: string;
  title: string;
  type?: "chat" | "automation";
  createdAt: string;
  /** True while the server is producing an assistant turn for this chat. */
  running?: boolean;
  /** Conversation focus: the account this chat works in; null/absent = no focus. */
  focusAccountId?: string | null;
  /** The thread currently under discussion, while one email is the topic. */
  focusThreadId?: string | null;
  /** Display subject for the focused thread (chip label). */
  focusThreadSubject?: string | null;
}

export interface ChatToolCall {
  id: string;
  name: string;
  /** Human-readable label from the tool definition; display falls back to `name` when absent. */
  label?: string;
  isError: boolean;
  done: boolean;
  detail?: string;
  /** Validated arguments and returned value, available in the expandable activity row. */
  parameters?: unknown;
  result?: unknown;
  /** Character offset in the assistant text at which this call started. */
  contentOffset?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Structured tool results this turn produced, so restored history re-renders its cards. */
  cards?: MessageCard[];
  /** Tool activity for assistant turns, persisted alongside cards and text. */
  toolCalls?: ChatToolCall[];
  /** Emails the user pinned to this message (composer @-mentions); user messages only. */
  refs?: EmailRef[];
  /** Turn-level failure shown inline when a response could not complete. */
  error?: string;
}

/** One persisted card of an assistant turn, keyed by the tool call that produced it. */
export interface MessageCard {
  toolCallId: string;
  card: AgentCard;
}

export interface Automation {
  id: string;
  name: string;
  /** Natural-language instruction the agent executes on each run. */
  instruction: string;
  /** Standard 5-field cron expression, e.g. "0 8 * * 1-5"; "" for a
   *  manual-only automation that runs only on demand ("Run now"). */
  schedule: string;
  enabled: boolean;
  /** Whether this automation's runs appear in the Home activity feed. */
  showInActivity: boolean;
  /** Exactly one automation may be pinned; its latest successful run leads the Home page. */
  pinned: boolean;
  /** Lead this automation belongs to (deleted with it); null for standalone automations. */
  leadId: string | null;
  /** Also run immediately when the mail probe sees new inbound mail, besides the cron schedule. */
  runOnNewMail: boolean;
  /** Show a desktop notification when a run of this automation finishes. */
  notifyOnCompletion: boolean;
  createdAt: string;
  /** Next scheduled run (ISO), null when disabled or not scheduled. */
  nextRunAt?: string | null;
}

/**
 * One proposed automation from the nightly suggestion sweep (the recurring
 * request patterns found in recent chat history), awaiting the user's
 * accept/dismiss on the Automations page. Decided rows are kept as dedup
 * context for later sweeps, never shown again.
 */
export interface AutomationSuggestion {
  id: string;
  name: string;
  /** Ready-to-run instruction, same shape an Automation carries. */
  instruction: string;
  /** Standard 5-field cron expression. */
  schedule: string;
  /** The recurring pattern the sweep saw — why this is being suggested. */
  rationale: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  /** When the user accepted or dismissed it; null while pending. */
  decidedAt: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: "running" | "success" | "error";
  /** Agent's final text (or the error message). */
  result: string;
  startedAt: string;
  finishedAt: string | null;
  /** Structured cards the run's turn produced — a briefing card renders instead of `result`. */
  cards?: MessageCard[];
}

/** One run in the cross-automation feed (Digest view). */
export interface RunFeedItem extends AutomationRun {
  automationName: string | null;
}

/**
 * An enabled automation whose most recent scheduled slot came and went without
 * a successful run — the machine was asleep or off when node-cron would have
 * fired. Only the latest missed slot is reported per automation ("run once"),
 * never one entry per skipped occurrence.
 */
export interface MissedAutomation {
  id: string;
  name: string;
  /** ISO of the missed scheduled slot. */
  dueAt: string;
}

/** Where a lead entered the pipeline. */
export type LeadSource = "email" | "manual" | "onoffice";

/** Estimated purchase likelihood; "" while unassessed. */
export type LeadScore = "high" | "medium" | "low" | "";

/**
 * Lead lifecycle: "new" = recorded, no outreach yet; "contacted" = we wrote
 * to them, awaiting reply; "engaged" = they replied, conversation ongoing;
 * "qualified" = a serious prospect; "won"/"lost" close the lead.
 */
export type LeadStatus = "new" | "contacted" | "engaged" | "qualified" | "won" | "lost";

/**
 * One prospect in the leads directory, keyed by normalized email address —
 * repeat interest from the same correspondent updates the row instead of
 * duplicating it. Follow-up automations reference the lead via
 * Automation.leadId and are deleted with it.
 */
export interface Lead {
  id: string;
  /** Display name; "" while unknown. */
  name: string;
  /** Normalized (lowercased) address — the lead's identity, unique. */
  email: string;
  phone: string;
  /** Connected account the correspondence runs through; "" when unknown. */
  accountId: string;
  source: LeadSource;
  /** Linked onOffice address record id, once the lead exists in the CRM. */
  onofficeAddressId: string | null;
  status: LeadStatus;
  /** What they're after (property, budget, area, …), free text. */
  interest: string;
  /** Buyer type in a few words (e.g. "Kapitalanleger", "junge Familie"); "" while unknown. */
  persona: string;
  score: LeadScore;
  notes: string;
  /** Last email received from the lead (ISO); null before the first inbound. */
  lastInboundAt: string | null;
  /** Last email sent to the lead (ISO); null before the first outreach. */
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One unsent draft, as it currently exists in the mail account. */
export interface EmailDraft {
  id: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  date: string;
  /** Deep link to review/send the draft in the provider's web UI. */
  webUrl: string;
  /** The Trailin conversation whose turn created this draft, when the agent wrote it. */
  conversationId?: string;
  /** Short plain-text preview of the body, for list rows. */
  snippet?: string;
}

/** Live drafts of one connected account (Drafts view). */
export interface AccountDrafts {
  account: string;
  accountId: string;
  drafts: EmailDraft[];
  error?: string;
}

/** One LLM provider known to the pi SDK, with its current auth state. */
export interface LlmProviderInfo {
  id: string;
  name: string;
  /** Supports a subscription-style OAuth login (Claude Pro/Max, Copilot, ChatGPT). */
  oauth: boolean;
  /** Display name of the OAuth login, e.g. "Anthropic (Claude Pro/Max)". */
  oauthName?: string;
  /** How the provider is currently authenticated. */
  auth: "subscription" | "stored_key" | "env" | null;
  /** e.g. "ANTHROPIC_API_KEY" when auth === "env". */
  authDetail?: string;
  modelCount: number;
}

/** State of the (single) in-flight OAuth login flow. */
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
  /** Whether the active model's provider has working credentials. */
  modelConfigured: boolean;
  /** Connected email accounts (0 when Pipedream is unconfigured or unreachable). */
  emailAccounts: number;
  /**
   * Whether `emailAccounts` is a real answer: true when the account list was
   * actually fetched, or when Pipedream isn't configured at all (0 is a real
   * answer then too). False only when Pipedream IS configured but listing
   * accounts failed — a transient outage, not a setup problem.
   */
  emailAccountsKnown: boolean;
  /**
   * Whether onOffice CRM credentials are configured. The whole lead surface
   * (leads page, lead tools, the seeded lead automations) exists only then —
   * leads are part of the real-estate workflow, not a standalone feature.
   */
  onofficeConfigured: boolean;
  provider: string;
  model: string;
}

/** The app is usable once the model has credentials and an email account is linked.
 *  An unknown account count (provider unreachable) never counts as incomplete —
 *  only a confirmed zero does. */
export function isSetupComplete(status: AppStatus): boolean {
  return status.modelConfigured && (status.emailAccounts > 0 || !status.emailAccountsKnown);
}

/** Longest a memory's content may be — about a sentence, since entries are injected in full. */
export const MEMORY_MAX_LENGTH = 300;

/** Hard cap on stored memory entries — every one is injected into the prompt, so the ceiling is small. */
export const MEMORY_MAX_COUNT = 200;

/**
 * One long-term memory entry, shown in the agent's system prompt. Scope is
 * one of three states — global (accountId and contactId both null),
 * account-scoped, or contact-scoped — never both accountId and contactId set.
 */
export interface MemoryEntry {
  id: string;
  content: string;
  /** "user" = added in Settings, "agent" = saved by the assistant itself. */
  source: "user" | "agent";
  /** Connected-account id this fact is scoped to; null = not account-scoped. */
  accountId: string | null;
  /** Normalized (lowercased) email address this fact is about; null = not contact-scoped. */
  contactId: string | null;
  /** Times the agent has reported relying on this memory (via memory_used) — the pruning signal. */
  usedCount: number;
  /** ISO timestamp of the most recent reported use; null until first used. */
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Longest a skill's instruction body may be — a playbook, not a document. */
export const SKILL_MAX_LENGTH = 10_000;

/**
 * One user-defined skill: a named playbook the agent follows on demand. The
 * name and description are listed in the agent's system prompt; the
 * instructions load only when the skill is invoked (skill_read). Stored as
 * one markdown file per skill in the skills folder.
 */
export interface Skill {
  /** Slug identity — also the markdown file's basename. */
  name: string;
  /** One line, shown in the agent's skill index and on the Knowledge page. */
  description: string;
  /** The playbook body the agent follows. */
  instructions: string;
  /** ISO mtime of the skill's file. */
  updatedAt: string;
}

/**
 * One recorded run of the draft-vs-sent learning sweep (match + extraction),
 * shown on the Knowledge page so "did the loop run, and what did it find"
 * is answerable without reading server logs.
 */
export interface LearnRun {
  id: string;
  /** "boot" = the catch-up sweep right after server start, "scheduled" = the nightly 03:00 run. */
  reason: "boot" | "scheduled";
  status: "ok" | "error";
  /** Drafts newly matched to a sent message by this run's match pass. */
  matched: number;
  /** Sent-but-unlearned drafts pending when extraction started. */
  pending: number;
  /** Pairs stamped learned without a lesson — the draft was sent unchanged. */
  identical: number;
  /** Edited pairs consumed by extraction this run. */
  learned: number;
  /** Style memories created from those pairs. */
  lessons: number;
  /** Failure detail when status is "error". */
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

/** GET /api/learn/status: recent sweep runs (newest first) and the next scheduled one. */
export interface LearnStatus {
  runs: LearnRun[];
  /** ISO timestamp of the next nightly sweep; null while the cron isn't scheduled. */
  nextRunAt: string | null;
}

/**
 * An account's latest voice-learn attempt (the automatic style analysis of
 * its sent mail). One record per account, overwritten on retry; "error"
 * stays until a rerun succeeds, so a failed or skipped learn is visible and
 * retryable from Settings instead of silently lost.
 */
export interface VoiceLearnRun {
  accountId: string;
  status: "running" | "ok" | "error";
  /** Why the attempt failed or was skipped, when status is "error". */
  error: string | null;
  startedAt: string;
  /** Null while the attempt is still running. */
  finishedAt: string | null;
}

/** One file of the local document library (the drop folder). */
export interface LibraryDocument {
  id: string;
  /** Path relative to the library folder, e.g. "contracts/lease.pdf". */
  path: string;
  /** File name without extension, used as the display title. */
  title: string;
  ext: string;
  /** File size in bytes. */
  size: number;
  status: "indexed" | "error";
  /** Extraction/indexing error, when status is "error". */
  error: string | null;
  chunkCount: number;
  /** Characters of extracted text. */
  textLength: number;
  modifiedAt: string;
  indexedAt: string;
}

export interface LibraryStatus {
  /** Absolute path of the drop folder on the server's machine. */
  folder: string;
  documents: LibraryDocument[];
}

/** One document match from GET /api/library/search. */
export interface LibrarySearchHit {
  id: string;
  title: string;
  path: string;
  ext: string;
  snippet: string;
}

/** Human-readable file size, e.g. "600 B", "12.9 KB", "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Provider handles of a just-created draft (POST /api/drafts/:accountId). */
export interface CreatedDraft {
  draftId: string;
  messageId: string;
  threadId: string;
  /** Deep link to review/send the draft in the provider's web UI. */
  webUrl: string;
}

/** Topics broadcast over GET /api/events when server-side data changes. */
export type ServerEventTopic =
  | "runs" // automation run started/finished (activity feed, run history)
  | "drafts" // a Gmail draft was created or deleted
  | "memories" // agent memory saved/updated/deleted
  | "skills" // skill written or deleted
  | "library" // library document written/changed
  | "conversations" // chat/automation conversation list changed
  | "automations" // automation definitions created/updated/deleted
  | "learn" // a learning sweep run was recorded
  | "leads" // a lead was recorded, updated or deleted
  | "whatsapp" // the WhatsApp link's connection state changed (pairing QR, open, unlinked)
  | "notification"; // a notify-flagged automation run finished (carries the payload)

/** Payload of a "notification" event — one finished run of a notify-flagged automation. */
export interface RunNotification {
  runId: string;
  automationId: string;
  automationName: string;
  status: "success" | "error";
  /** First line of the run's result, truncated for a notification body. */
  summary: string;
}

export interface ServerEvent {
  topic: ServerEventTopic;
  /** Present only on "notification" events. */
  notification?: RunNotification;
}

/** Server-sent events streamed from POST /api/chat. */
export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking" }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      /** Human-readable label from the tool definition (falls back to the name server-side). */
      toolLabel: string;
      parameters?: unknown;
      contentOffset: number;
    }
  /** Progress text from a long-running tool (e.g. delegate's "2/5 tasks done"), between its tool_start and tool_end. */
  | { type: "tool_update"; toolCallId: string; toolName: string; detail: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result?: unknown }
  /**
   * A tool returned structured data the chat renders as a component. Emitted
   * between that tool's `tool_start` and `tool_end`. Cards are also persisted
   * with the assistant message (ChatMessage.cards), so restored history
   * re-renders them; only the tool badges are live-turn-only.
   */
  | { type: "card"; toolCallId: string; card: AgentCard }
  | { type: "done"; text: string }
  | { type: "error"; message: string };
