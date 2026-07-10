import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EmailThreadMessage } from "@trailin/shared";
import { relativeTime } from "@/lib/dates";

/**
 * Read-only context above an editable draft: the messages it replies to.
 * Every message collapsed except the last — the one actually being replied
 * to — mirroring chat/cards/EmailThreadCard.tsx's convention (not reused
 * directly: that component is welded to the chat CardShell/AgentCard union).
 */
export function ThreadHistory({ messages }: { messages: EmailThreadMessage[] }) {
  const { i18n } = useTranslation();
  const lastIndex = messages.length - 1;
  const [openIndexes, setOpenIndexes] = React.useState<Set<number>>(
    () => new Set(lastIndex >= 0 ? [lastIndex] : []),
  );

  if (messages.length === 0) return null;

  const toggle = (index: number) => {
    setOpenIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    // A left rule, not a card — this is context for the draft below it, not content of its own.
    <div className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
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
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-1.5 pr-1 text-left transition-colors hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {message.from}
        </span>
        <time className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {relativeTime(message.date, lang)}
        </time>
      </button>
      {open && (
        // Literal email body — never markdown, see DraftRow.tsx.
        <p className="whitespace-pre-wrap px-1 pb-2 pl-5 text-xs leading-relaxed text-muted-foreground">
          {message.body}
        </p>
      )}
    </div>
  );
}
