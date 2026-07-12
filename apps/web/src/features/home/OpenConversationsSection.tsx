import type { AccountColor, OpenConversations } from "@trailin/shared";
import { AlertTriangle, ExternalLink, MessagesSquare, PenLine, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { AccountDot } from "@/components/ui/account-dot";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { CollapsibleSectionTitle } from "@/features/home/CollapsibleSectionTitle";
import { api } from "@/lib/api";
import { dispatchQuickAction } from "@/lib/quickActions";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/utils";

/**
 * Home's "Open conversations" section, two lanes over the mailbox mirror +
 * enrichment (server: email/waiting.ts):
 *
 * - "Waiting on you": inbound threads enrichment triaged needs_reply. Primary
 *   action prefills a reply draft in chat (the same trailin:prefill-chat /
 *   trailin:send-chat mechanism BriefingCard's row actions use, via
 *   lib/quickActions.ts); dismiss removes a row with no confirm — the server
 *   auto-clears the dismissal once a new inbound message changes the
 *   thread's hash, so a wrong dismiss self-heals rather than needing undo.
 * - "Waiting on others": sent threads enrichment judged still awaiting a
 *   reply — unchanged nudge-draft + open-in-webmail actions.
 *
 * Only renders once there's something to show in either lane; a lane with no
 * items simply omits its own heading rather than showing an empty state.
 */
export function OpenConversationsSection({
  waiting,
  colors,
}: {
  waiting: OpenConversations | null;
  colors: AccountColor[];
}) {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(true);
  // Optimistic client-side veil over dismissed rows — the server-side
  // dismissal only clears once a new inbound message changes the thread's
  // hash, so hiding locally (rather than waiting on the next full refetch)
  // is what makes the click feel instant.
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(new Set());

  const youItems = React.useMemo(
    () =>
      (waiting?.waitingOnYou ?? [])
        .flatMap((account) => account.items.map((item) => ({ ...item, account: account.account })))
        .filter((item) => !dismissed.has(`${item.accountId}-${item.threadId}`)),
    [waiting, dismissed],
  );

  const otherItems = React.useMemo(
    () =>
      (waiting?.waitingOnOthers ?? []).flatMap((account) =>
        account.items.map((item) => ({
          ...item,
          account: account.account,
          accountId: account.accountId,
        })),
      ),
    [waiting],
  );

  const relativeTime = React.useMemo(
    () => new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" }),
    [i18n.language],
  );
  const relativeLabel = (iso: string) => {
    const t0 = new Date(iso).getTime();
    if (Number.isNaN(t0)) return "";
    const days = Math.round((t0 - Date.now()) / (24 * 60 * 60 * 1000));
    return relativeTime.format(days, "day");
  };

  if (waiting === null || (youItems.length === 0 && otherItems.length === 0)) return null;

  const dismiss = async (accountId: string, threadId: string) => {
    const key = `${accountId}-${threadId}`;
    setDismissed((prev) => new Set(prev).add(key));
    try {
      await api.dismissWaiting(accountId, threadId);
    } catch (err) {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      toast.error(err);
    }
  };

  const draftReply = (item: {
    counterpart: string;
    subject: string;
    account: string;
    threadId: string;
    gist: string;
  }) => {
    dispatchQuickAction(
      t("home.waitingOnYouDraftReplyPrompt", {
        counterpart: item.counterpart,
        subject: item.subject,
        account: item.account,
        threadId: item.threadId,
        gist: item.gist,
      }),
    );
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
      <CollapsibleSectionTitle
        icon={MessagesSquare}
        title={t("home.openConversationsTitle")}
        count={youItems.length + otherItems.length}
        expanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />

      {isExpanded && (
        <div className="flex flex-col gap-8">
          {youItems.length > 0 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("home.waitingOnYouTitle")}
              </h3>
              <div className="flex flex-col gap-3">
                {youItems.map((item, i) => (
                  <ListRow
                    key={`${item.accountId}-${item.threadId}`}
                    className="animate-in-up"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <AccountDot
                      className="h-2.5 w-2.5"
                      color={colors.find((c) => c.accountId === item.accountId)?.hex}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.urgency === "high" && (
                          <AlertTriangle
                            className="mr-1 -mt-0.5 inline-block h-3.5 w-3.5 shrink-0 text-warning"
                            aria-hidden
                          />
                        )}
                        {item.subject}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.counterpart} · {item.gist}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-accent/10 hover:text-accent"
                        onClick={() => draftReply(item)}
                        title={t("home.waitingOnYouDraftReply")}
                        aria-label={t("home.waitingOnYouDraftReply")}
                      >
                        <PenLine className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openExternal(item.webUrl)}
                        title={t("drafts.open")}
                        aria-label={t("drafts.open")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void dismiss(item.accountId, item.threadId)}
                        title={t("home.waitingOnYouDismiss")}
                        aria-label={t("home.waitingOnYouDismiss")}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </ListRow>
                ))}
              </div>
            </div>
          )}

          {otherItems.length > 0 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("home.waitingTitle")}
              </h3>
              <div className="flex flex-col gap-3">
                {otherItems.map((item, i) => (
                  <ListRow
                    key={`${item.accountId}-${item.threadId}`}
                    className="animate-in-up"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <AccountDot
                      className="h-2.5 w-2.5"
                      color={colors.find((c) => c.accountId === item.accountId)?.hex}
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
                        size="icon-sm"
                        onClick={() => openExternal(item.webUrl)}
                        title={t("drafts.open")}
                        aria-label={t("drafts.open")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-accent/10 hover:text-accent"
                        onClick={() => nudge(item.counterpart, item.subject, item.account)}
                        title={t("home.waitingNudge")}
                        aria-label={t("home.waitingNudge")}
                      >
                        <PenLine className="h-4 w-4" />
                      </Button>
                    </div>
                  </ListRow>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
