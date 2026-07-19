export interface EmailRef {
  threadId: string;
  accountId: string;
  accountName?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  date?: string;
}

export interface CardAccount {
  accountId: string;
  name: string;
  app: string;
  appName?: string;
  imgSrc?: string;
}

export interface EmailThreadMessage {
  id?: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  /** Rendered literally: email bodies are never markdown. */
  body: string;
  subject?: string;
  isUnread?: boolean;
  isFromMe?: boolean;
}

export interface DraftPreview {
  draftId: string;
  threadId?: string;
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  webUrl?: string;
  attachments?: { filename: string; size?: number }[];
}

/** A real enum the UI groups on, never a marker parsed back out of prose. */
export const BRIEFING_PRIORITIES = ["urgent", "reply", "action", "fyi"] as const;
export type BriefingPriority = (typeof BRIEFING_PRIORITIES)[number];

export interface BriefingItem {
  threadId: string;
  messageId?: string;
  accountId?: string;
  sender: string;
  senderEmail?: string;
  subject: string;
  gist: string;
  priority: BriefingPriority;
  deadline?: string;
  receivedAt?: string;
  draftId?: string;
  webUrl?: string;
}

export interface BriefingRollup {
  label: string;
  items: BriefingItem[];
}

export interface ChoiceOption {
  label: string;
  detail?: string;
  /** Reply sent when picked; defaults to `label`. */
  reply?: string;
  ref?: EmailRef;
}

export interface AttachmentItem {
  accountId: string;
  messageId: string;
  filename: string;
  /** Provider's declared type, for display only: the served MIME is derived from the filename. */
  mimeType?: string;
  size?: number;
  viewable: boolean;
  saveable: boolean;
}

export type AgentCard =
  | { kind: "email_draft"; account?: CardAccount; draft: DraftPreview }
  | { kind: "message_draft"; channel: string; targetLabel: string; body: string; draftId: string }
  | {
      kind: "attachments";
      account?: CardAccount;
      subject?: string;
      items: AttachmentItem[];
    }
  | {
      kind: "choices";
      question: string;
      options: ChoiceOption[];
    }
  | {
      kind: "briefing";
      headline?: string;
      periodLabel?: string;
      accounts?: CardAccount[];
      items: BriefingItem[];
      rollups?: BriefingRollup[];
      scanned?: number;
    };
