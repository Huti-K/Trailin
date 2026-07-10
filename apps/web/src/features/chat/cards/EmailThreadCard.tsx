import * as React from "react";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentCard, EmailThreadMessage } from "@trailin/shared";
import { relativeTime } from "@/lib/dates";
import { CardShell } from "./CardShell";

type EmailThreadData = Extract<AgentCard, { kind: "email_thread" }>;

/**
 * The get-thread view: every message collapsed except the last —
 * that's the one being replied to, so it's the one worth reading first.
 */
export function EmailThreadCard({ card, color }: { card: EmailThreadData; color?: string }) {
  const { t, i18n } = useTranslation();
  const { account, subject, messages } = card;
  const lastIndex = messages.length - 1;
  const [openIndexes, setOpenIndexes] = React.useState<Set<number>>(
    () => new Set(lastIndex >= 0 ? [lastIndex] : []),
  );
  // A retried tool call replaces this card's `messages` in place, reusing this
  // same component instance (ChatPanel's "card" handler and turnCards.ts both
  // key by toolCallId). Re-derive which message is open whenever the array
  // itself changes, not just once on mount.
  const [trackedMessages, setTrackedMessages] = React.useState(messages);
  if (messages !== trackedMessages) {
    setTrackedMessages(messages);
    setOpenIndexes(new Set(lastIndex >= 0 ? [lastIndex] : []));
  }

  const toggle = (index: number) => {
    setOpenIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <CardShell
      icon={MessagesSquare}
      label={t("chat.cards.thread.label")}
      meta={t("chat.cards.thread.messageCount", { count: messages.length })}
      title={subject || t("chat.cards.noSubject")}
      account={account}
      color={color}
    >
      <div className="flex flex-col px-2 pb-2">
        {messages.map((message, index) => (
          <ThreadMessageRow
            key={index}
            message={message}
            open={openIndexes.has(index)}
            onToggle={() => toggle(index)}
            lang={i18n.language}
          />
        ))}
      </div>
    </CardShell>
  );
}

function ThreadMessageRow({
  message,
  open,
  onToggle,
  lang,
}: {
  message: EmailThreadMessage;
  open: boolean;
  onToggle: () => void;
  lang: string;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{message.from}</span>
        <time className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {relativeTime(message.date, lang)}
        </time>
      </button>

      {open && (
        /* Body indents to the sender's text edge, keeping the chevron column clear. */
        <div className="flex flex-col gap-2 pb-3 pl-[30px] pr-3 pt-0.5">
          {message.to.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono text-[11px]">{t("chat.cards.thread.to")}</span>{" "}
              {message.to.join(", ")}
            </p>
          )}
          {message.cc && message.cc.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono text-[11px]">{t("chat.cards.thread.cc")}</span>{" "}
              {message.cc.join(", ")}
            </p>
          )}
          {/* Literal email body — never markdown, see DraftRow.tsx:133-134. */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.body || t("chat.cards.emptyBody")}
          </p>
        </div>
      )}
    </div>
  );
}
