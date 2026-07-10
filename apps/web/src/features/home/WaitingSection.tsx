import * as React from "react";
import { ChevronDown, ChevronUp, ExternalLink, Hourglass, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccountColor, AccountWaiting } from "@trailin/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UNASSIGNED_ACCOUNT_COLOR } from "@/lib/utils";

/**
 * "Waiting on others" — sent threads nobody has replied to yet, flattened
 * across every connected account. Only renders once there's something to
 * show; per-account fetch errors are ignored here since ReviewSection/drafts
 * already surface connectivity problems.
 */
export function WaitingSection({
  waiting,
  colors,
}: {
  waiting: AccountWaiting[] | null;
  colors: AccountColor[];
}) {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(true);

  const items = React.useMemo(
    () =>
      (waiting ?? []).flatMap((account) =>
        account.items.map((item) => ({ ...item, account: account.account, accountId: account.accountId })),
      ),
    [waiting],
  );

  const relativeTime = React.useMemo(
    () => new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" }),
    [i18n.language],
  );

  if (waiting === null || items.length === 0) return null;

  const relativeLabel = (iso: string) => {
    const t0 = new Date(iso).getTime();
    if (Number.isNaN(t0)) return "";
    const days = Math.round((t0 - Date.now()) / (24 * 60 * 60 * 1000));
    return relativeTime.format(days, "day");
  };

  const nudge = (counterpart: string, subject: string, account: string) => {
    window.dispatchEvent(new CustomEvent("trailin:show-chat"));
    window.dispatchEvent(
      new CustomEvent("trailin:prefill-chat", {
        detail: { text: t("home.waitingNudgePrompt", { counterpart, subject, account }) },
      }),
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <h2
        className="flex items-center gap-2.5 text-base font-semibold tracking-tight cursor-pointer hover:text-muted-foreground transition-colors select-none"
        onClick={() => setIsExpanded(!isExpanded)}
        title={isExpanded ? "Collapse" : "Expand"}
      >
        <div className="tint-accent flex h-7 w-7 items-center justify-center rounded-md">
          <Hourglass className="h-4 w-4" />
        </div>
        {t("home.waitingTitle")}
        <Badge variant="muted">{items.length}</Badge>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground ml-1" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground ml-1" />
        )}
      </h2>

      {isExpanded && (
        <div className="flex flex-col gap-3">
          {items.map((item, i) => (
            <div
              key={`${item.accountId}-${item.threadId}`}
              className="animate-in-up flex items-center gap-3 rounded-lg bg-surface-2 px-3.5 py-3"
              style={{ animationDelay: `${i * 45}ms` }}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    colors.find((c) => c.accountId === item.accountId)?.hex ??
                    UNASSIGNED_ACCOUNT_COLOR,
                }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.subject}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.counterpart} · {relativeLabel(item.lastSentAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  onClick={() => window.open(item.webUrl, "_blank", "noopener,noreferrer")}
                  title={t("drafts.open")}
                  aria-label={t("drafts.open")}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:bg-accent/10 hover:text-accent"
                  onClick={() => nudge(item.counterpart, item.subject, item.account)}
                  title={t("home.waitingNudge")}
                  aria-label={t("home.waitingNudge")}
                >
                  <PenLine className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
