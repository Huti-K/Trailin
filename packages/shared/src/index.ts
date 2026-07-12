export * from "./unsubscribe.js";

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
 * A user-written note on a connected account describing what it's for. Unlike
 * the app/name (which come from Pipedream), this is app-local and, crucially,
 * fed to the agent as tool context so it knows why the connection exists
 * (e.g. a Notion account connected "to save meeting notes").
 */
export interface AccountDescription {
  /** Pipedream account id. */
  accountId: string;
  /** Free-text purpose, e.g. "Save meeting notes here". */
  text: string;
}

/**
 * Per-account voice: the signature applied mechanically by the create-draft
 * tool. Like AccountDescription this is app-local. Writing style is NOT a
 * field here — style directives live as account-scoped memories, learned from
 * sent mail by voiceLearn or written by the user, and reach the agent through
 * the memory section of its system prompt.
 */
export interface AccountVoice {
  /** Pipedream account id. */
  accountId: string;
  /** Plain-text form, used for previews and backwards compatibility. */
  signature?: string;
  /** Sanitized rich-text signature HTML, as authored/pasted in Settings. */
  signatureHtml?: string;
  /** Set when the signature/style was last derived from the account's sent mail. */
  learnedAt?: string;
  /** Memory ids the last voice-learn run wrote, so re-learning replaces them. */
  styleMemoryIds?: string[];
}

/** One hit from the global search (GET /api/search). */
export interface SearchResult {
  /** What the hit is; decides the icon and where clicking navigates. */
  type: "chat" | "run" | "draft" | "mail" | "document" | "memory";
  /** conversationId | automation run id | draft id | provider message id (mail) | document id | memory id. */
  id: string;
  title: string;
  /** Short plain-text context around the match. */
  snippet: string;
  /** ISO timestamp for ordering, when the source has one. */
  date?: string;
  /** Owning email account (draft and mail hits), for inbox chips and navigation. */
  accountId?: string;
  /** Deep link to the provider's webmail UI (mail hits only); absent when the account's app has no known web UI. */
  webUrl?: string;
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

/**
 * One specific email pinned to a chat message — the composer's @-mention, a
 * card's "add to chat" action, or a choices-card pick. threadId/accountId are
 * the authoritative handles (provider-native thread id + connected-account
 * id); the display fields ride along so chips and prompt notes render without
 * re-querying the mirror.
 */
export interface EmailRef {
  /** Provider-native thread id — what read_thread and create-draft understand. */
  threadId: string;
  accountId: string;
  /** Display name of the account, usually its address. */
  accountName?: string;
  /** Provider-native message id, when the mention targets one message rather than the whole thread. */
  messageId?: string;
  subject?: string;
  /** "Name <address>" or a bare address. */
  from?: string;
  date?: string;
}

/** One row of GET /api/mail/suggest — an email the composer's @-mention can attach. */
export interface MailSuggestion {
  threadId: string;
  accountId: string;
  /** Present for message-level matches (keyword search); absent for recent-thread rows. */
  messageId?: string;
  subject: string;
  from: string;
  date: string;
  snippet?: string;
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
  /** Standard 5-field cron expression, e.g. "0 8 * * 1-5". */
  schedule: string;
  enabled: boolean;
  /** Whether this automation's runs appear in the Home activity feed. */
  showInActivity: boolean;
  /** Exactly one automation may be pinned; its latest successful run leads the Home page. */
  pinned: boolean;
  createdAt: string;
  /** Next scheduled run (ISO), null when disabled or not scheduled. */
  nextRunAt?: string | null;
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

/** One sent thread still awaiting a counterpart's reply (Home "Waiting on others"). */
export interface WaitingThread {
  threadId: string;
  subject: string;
  /** Display name/address of the recipient of the last sent message. */
  counterpart: string;
  /** When the user's last (unanswered) message was sent. */
  lastSentAt: string;
  /** Deep link to the thread in the provider's web UI. */
  webUrl: string;
}

/** Pending threads of one connected account. */
export interface AccountWaiting {
  account: string;
  accountId: string;
  items: WaitingThread[];
  error?: string;
}

/**
 * One thread where the newest message is inbound and enrichment triaged it
 * needs_reply (Home "Waiting on you" — the other lane of "Open
 * conversations", alongside WaitingThread/AccountWaiting above).
 */
export interface WaitingOnYouThread {
  threadId: string;
  /** Connected account this thread belongs to; resolves the row's colour dot. */
  accountId: string;
  subject: string;
  /** Display name/address of the message's sender. */
  counterpart: string;
  /** One-sentence summary from enrichment. */
  gist: string;
  urgency: ThreadUrgency;
  /** Deep link to the thread in the provider's web UI. */
  webUrl: string;
}

/** Threads needing the owner's reply, for one connected account (Home "Waiting on you"). */
export interface AccountWaitingOnYou {
  account: string;
  accountId: string;
  items: WaitingOnYouThread[];
  error?: string;
}

/** GET /api/waiting's response: the two lanes of Home's "Open conversations" section. */
export interface OpenConversations {
  waitingOnYou: AccountWaitingOnYou[];
  waitingOnOthers: AccountWaiting[];
}

/** The account a card's data came from. The client resolves its AccountColor. */
export interface CardAccount {
  accountId: string;
  /** Usually the account's email address. */
  name: string;
  /** Pipedream app slug, e.g. "gmail". */
  app: string;
  appName?: string;
  imgSrc?: string;
}

/** One message in an email search result list. */
export interface EmailHit {
  messageId: string;
  threadId: string;
  /** Connected account the hit lives in — set on cross-account searches so row actions can build an EmailRef. */
  accountId?: string;
  subject: string;
  /** "Name <address>" or a bare address. */
  from: string;
  to: string[];
  date: string;
  /** Short plain-text excerpt of the body. */
  snippet: string;
}

/** One message inside a thread card. */
export interface EmailThreadMessage {
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  /** Plain-text body. Rendered literally — email bodies are never markdown. */
  body: string;
}

/** Response of GET /api/threads/:accountId/:threadId — oldest message first. */
export interface EmailThread {
  messages: EmailThreadMessage[];
}

/** A composed, unsent draft, as the create-draft tool built it. */
export interface DraftPreview {
  draftId: string;
  threadId?: string;
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  /** Deep link to review/send in the provider's web UI. */
  webUrl?: string;
  /** The account's signature was appended to `body`. */
  signatureAppended?: boolean;
}

/**
 * What one briefed message needs from the user, most pressing first. These are
 * the four tiers the Morning briefing automation ranks by; the agent picks one
 * per item and the UI groups on it, so the tier is a real enum rather than a
 * marker character parsed back out of prose.
 */
export const BRIEFING_PRIORITIES = ["urgent", "reply", "action", "fyi"] as const;
export type BriefingPriority = (typeof BRIEFING_PRIORITIES)[number];

/** One noteworthy message in a briefing, as the agent triaged it. */
export interface BriefingItem {
  /** Thread the message belongs to — the handle every row action needs. */
  threadId: string;
  messageId?: string;
  /** Connected account this landed in; resolves to the row's colour chip. */
  accountId?: string;
  /** Display name of the sender, e.g. "Ayşe Kaya". */
  sender: string;
  senderEmail?: string;
  subject: string;
  /** One sentence on what it says and what it wants. */
  gist: string;
  priority: BriefingPriority;
  /** When it must be answered by, in the sender's own terms ("Friday 17:00"). */
  deadline?: string;
  receivedAt?: string;
  /** Draft this run saved against the thread, if it wrote one. */
  draftId?: string;
  /** Deep link to the thread in the account's webmail UI, resolved server-side from threadId + account. */
  webUrl?: string;
}

/** A bucket of low-value mail collapsed to a count instead of listed. */
export interface BriefingRollup {
  accountId?: string;
  /** e.g. "Newsletters", "Receipts", "Promotions". */
  label: string;
  count: number;
  /** A few sender names, to show what was folded away. */
  examples?: string[];
}

/**
 * One clickable answer in a choices card. Picking it sends `reply` (falling
 * back to `label`) as the user's next message in the same conversation, with
 * `ref` attached when the option names a specific email.
 */
export interface ChoiceOption {
  /** Short button text, e.g. an account address or "Ayşe — Friday deadline". */
  label: string;
  /** One-line supporting detail (subject, date, account). */
  detail?: string;
  /** Full-sentence reply sent when picked; defaults to `label`. */
  reply?: string;
  /** The email this option refers to, when it names one. */
  ref?: EmailRef;
}

/**
 * A structured tool result the chat renders as a component instead of prose.
 *
 * Tools return one on their result's `details` slot; run.ts forwards it and
 * chat.ts streams it as a `card` event. The text content is still returned
 * alongside — the model reads the prose, the user sees the card. Tools that
 * return nothing recognizable degrade to the plain tool badge.
 */
export type AgentCard =
  | {
      kind: "email_hits";
      account?: CardAccount;
      /** The search the agent ran, echoed back as a header. */
      query?: string;
      hits: EmailHit[];
      /** More matches existed than were returned. */
      truncated?: boolean;
    }
  | {
      kind: "email_thread";
      account?: CardAccount;
      threadId: string;
      subject: string;
      messages: EmailThreadMessage[];
    }
  | { kind: "email_draft"; account?: CardAccount; draft: DraftPreview }
  | {
      kind: "choices";
      /** The question the agent needs answered before it can act, e.g. "Which email do you mean?". */
      question: string;
      options: ChoiceOption[];
    }
  | {
      kind: "briefing";
      /** One line on where the user stands, e.g. "Two things need you today". */
      headline?: string;
      /** The window reviewed, in the agent's words ("since yesterday morning"). */
      periodLabel?: string;
      /** Every account the briefing covered, so empty ones still get credit. */
      accounts?: CardAccount[];
      /** Flat and cross-account: the UI groups by priority, not by inbox. */
      items: BriefingItem[];
      rollups?: BriefingRollup[];
      /** Total messages reviewed, including the ones rolled up. */
      scanned?: number;
    };

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
  /** Contact address (contacts.address, lowercased) this fact is about; null = not contact-scoped. */
  contactId: string | null;
  createdAt: string;
  updatedAt: string;
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

/** Human-readable file size, e.g. "600 B", "12.9 KB", "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether an address is a real correspondent or a bulk/newsletter sender, as
 * the contacts pipeline (server: email/contacts/) judged it. Authoritative —
 * not derived from a no-reply regex, which is only a prior the judgment may
 * consider.
 */
export const CONTACT_KINDS = ["person", "bulk"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** Relationship bucket for a "person" contact; not meaningful for "bulk". */
export const CONTACT_CATEGORIES = [
  "colleague",
  "client_business",
  "personal",
  "service_vendor",
  "other",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

/**
 * One row of the mailbox-derived contacts core (server: email/contacts/) —
 * one per correspondent address, never per person. Aggregates
 * (messageCount/sentCount/lastContactAt/accounts) are re-derived from the
 * mailbox mirror; kind/category/gist are LLM judgments that persist across
 * re-derivation. `categorySource: "user"` marks the one field the Contacts
 * page can override, which then survives future judgments.
 */
export interface Contact {
  /** Normalized (lowercased) email address — the contact's identity. */
  address: string;
  displayName: string;
  kind: ContactKind;
  category: ContactCategory;
  categorySource: "auto" | "user";
  /** One LLM-written relationship line, e.g. "your accountant; formal tone". */
  gist: string;
  /** Connected-account ids this address corresponds on. */
  accounts: string[];
  messageCount: number;
  /** Messages the user sent to this address. */
  sentCount: number;
  lastContactAt: string;
  /** Model id that produced kind/category/gist; null before the first judgment. */
  model: string | null;
  error: string | null;
  enrichedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One thread involving a contact (GET /api/contacts/:address's recentThreads). */
export interface ContactThread {
  /** Provider thread id. */
  threadId: string;
  accountId: string;
  subject: string;
  /** The thread's last-message timestamp. */
  date: string;
  /** Enrichment gist, when the thread has been triaged; "" otherwise. */
  gist: string;
  /** Deep link to the thread in the provider's web UI; "" when unknown. */
  webUrl: string;
}

/** GET /api/contacts/:address's response. */
export interface ContactDetail extends Contact {
  /** Up to 15 threads involving this address, newest first. */
  recentThreads: ContactThread[];
}

/** Topics broadcast over GET /api/events when server-side data changes. */
/**
 * Lifecycle triage of a mail thread relative to the user, as the enrichment
 * pipeline (server: email/enrich/) judged it. Orthogonal to urgency: triage
 * says WHO the ball is with, urgency says how hot it is.
 */
export const THREAD_TRIAGES = ["needs_reply", "needs_action", "waiting_on", "fyi", "done"] as const;
export type ThreadTriage = (typeof THREAD_TRIAGES)[number];

export const THREAD_URGENCIES = ["high", "normal", "low"] as const;
export type ThreadUrgency = (typeof THREAD_URGENCIES)[number];

export type ServerEventTopic =
  | "runs" // automation run started/finished (activity feed, run history)
  | "drafts" // a Gmail draft was created or deleted
  | "mail" // the local mailbox mirror changed (messages synced/updated/removed)
  | "mail_state" // enrichment updated thread summaries/triage (email/enrich/)
  | "contacts" // contacts derived/enriched, or a category overridden (email/contacts/)
  | "memories" // agent memory saved/updated/deleted
  | "library" // library document written/changed
  | "conversations" // chat/automation conversation list changed
  | "automations"; // automation definitions created/updated/deleted

export interface ServerEvent {
  topic: ServerEventTopic;
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
