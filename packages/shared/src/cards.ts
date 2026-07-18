/**
 * The chat-card render contract: the `AgentCard` discriminated union the chat
 * renders instead of prose, plus the payload shapes its arms carry. A tool
 * returns one on its result's `details` slot; the server streams it as a
 * `card` event and the web app renders it. Re-exported from index.js, so
 * consumers import these from "@trailin/shared".
 */

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

/**
 * One message in a thread read live from a provider (email/read; the web
 * app's thread-history view renders it). Every field beyond the display
 * basics is optional — providers carry only what they know, so every
 * consumer must tolerate absence.
 */
export interface EmailThreadMessage {
  /** Provider message id. */
  id?: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  /** Plain-text body. Rendered literally — email bodies are never markdown. */
  body: string;
  subject?: string;
  isUnread?: boolean;
  isFromMe?: boolean;
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
  /** Files attached to the draft, for the human's pre-send review. */
  attachments?: { filename: string; size?: number }[];
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

/**
 * A group of low-value mail (newsletters, receipts, notifications…) gathered
 * under one kind label but still listed message by message, so each stays an
 * actionable row — the card renders every item beneath the group heading with
 * the same per-thread actions the tier items get.
 */
export interface BriefingRollup {
  /** e.g. "Newsletters", "Receipts", "Promotions", "Notifications". */
  label: string;
  /** The individual messages in this group, each its own clickable row. */
  items: BriefingItem[];
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
 * One attachment on an email message, as the list-attachments tool surfaced
 * it. Carries the exact handle its row actions need — `accountId` + `messageId`
 * + `filename` address the bytes through `GET /api/mail/attachments/open`.
 */
export interface AttachmentItem {
  /** Connected account the message lives in. */
  accountId: string;
  /** Provider message id the attachment hangs off (from search_mail / read_thread). */
  messageId: string;
  filename: string;
  /** The provider's declared type, for display only — the served MIME is derived from the filename. */
  mimeType?: string;
  /** Size in bytes, when the provider reported it. */
  size?: number;
  /** The viewer can render this type inline (PDF, image, plain text); others download only. */
  viewable: boolean;
  /** The document library accepts this format, so "Save to library" applies. */
  saveable: boolean;
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
  | { kind: "email_draft"; account?: CardAccount; draft: DraftPreview }
  | {
      kind: "attachments";
      account?: CardAccount;
      /** Subject of the message the attachments hang off, shown as the card title. */
      subject?: string;
      items: AttachmentItem[];
    }
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
