import type {
  AccountColor,
  AgentCard,
  BriefingItem,
  BriefingPriority,
  CardAccount,
} from "@trailin/shared";
import { BRIEFING_PRIORITIES } from "@trailin/shared";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  ExternalLink,
  Eye,
  MessageCircleQuestion,
  PenLine,
  Sunrise,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { AccountDot } from "@/components/ui/account-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dispatchQuickAction } from "@/lib/quickActions";
import { cn, openExternal } from "@/lib/utils";
import { CardShell } from "./CardShell";

type BriefingData = Extract<AgentCard, { kind: "briefing" }>;

/**
 * The structured Morning-briefing card — flat and cross-account by design
 * (see apps/web/DESIGN.md and the `kind: "briefing"` doc comment on
 * AgentCard). Priority is the grouping axis, not the inbox: an account only
 * ever shows up as a colour dot on a row. A run whose turn produced no card
 * renders as markdown via DigestView instead (see BriefingHero's degrade).
 */
export function BriefingCard({ card, colors }: { card: BriefingData; colors?: AccountColor[] }) {
  const { t } = useTranslation();
  const { headline, periodLabel, accounts, items, rollups, scanned } = card;
  const [fyiOpen, setFyiOpen] = React.useState(false);

  const grouped = React.useMemo(() => {
    const map = new Map<BriefingPriority, BriefingItem[]>(BRIEFING_PRIORITIES.map((p) => [p, []]));
    for (const item of items) {
      // Every BriefingPriority (including "fyi") seeds a bucket above, so this
      // always resolves — the optional chain only guards the Map API's typing.
      const bucket = map.get(item.priority) ?? map.get("fyi");
      bucket?.push(item);
    }
    return map;
  }, [items]);

  const urgentCount = grouped.get("urgent")?.length ?? 0;
  const replyCount = grouped.get("reply")?.length ?? 0;
  const draftsReadyCount = items.filter((i) => i.draftId).length;
  const rolledUpCount = rollups?.reduce((n, r) => n + r.count, 0) ?? 0;

  const otherStats: string[] = [];
  if (replyCount > 0) otherStats.push(t("chat.cards.briefing.stats.reply", { count: replyCount }));
  if (draftsReadyCount > 0) {
    otherStats.push(t("chat.cards.briefing.stats.draftsReady", { count: draftsReadyCount }));
  }
  if (rolledUpCount > 0)
    otherStats.push(t("chat.cards.briefing.stats.rolledUp", { count: rolledUpCount }));
  if (typeof scanned === "number") {
    otherStats.push(t("chat.cards.briefing.stats.scanned", { count: scanned }));
  }

  const hasStats = urgentCount > 0 || otherStats.length > 0;

  return (
    <CardShell
      icon={Sunrise}
      label={t("chat.cards.briefing.label")}
      meta={
        items.length > 0 ? t("chat.cards.briefing.itemCount", { count: items.length }) : undefined
      }
    >
      <div className="flex flex-col gap-4 px-4 pb-4 pt-0.5">
        {(headline || periodLabel) && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {headline && <p className="text-sm font-semibold tracking-tight">{headline}</p>}
            {periodLabel && <p className="text-xs text-muted-foreground">{periodLabel}</p>}
          </div>
        )}

        {hasStats && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {urgentCount > 0 && (
              <Badge variant="destructive">
                {t("home.briefingUrgent", { count: urgentCount })}
              </Badge>
            )}
            {otherStats.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {otherStats.join(" · ")}
              </span>
            )}
          </div>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("chat.cards.briefing.empty")}</p>
        ) : (
          BRIEFING_PRIORITIES.map((priority) => {
            const groupItems = grouped.get(priority) ?? [];
            if (groupItems.length === 0) return null;
            const isFyi = priority === "fyi";
            const expanded = !isFyi || fyiOpen;

            return (
              <div key={priority} className="flex flex-col gap-1.5">
                {isFyi ? (
                  <button
                    type="button"
                    onClick={() => setFyiOpen((v) => !v)}
                    aria-expanded={fyiOpen}
                    className="flex w-fit items-center gap-1.5 rounded-md px-0.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 shrink-0 transition-transform",
                        !fyiOpen && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    {fyiOpen
                      ? t("chat.cards.briefing.groups.fyi")
                      : t("chat.cards.briefing.showMore", { count: groupItems.length })}
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 px-0.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(`chat.cards.briefing.groups.${priority}`)}
                    </h4>
                    <span className="font-mono text-2xs tabular-nums text-muted-foreground/70">
                      {groupItems.length}
                    </span>
                  </div>
                )}

                {expanded && (
                  <div className="flex flex-col gap-1">
                    {groupItems.map((item, index) => (
                      <BriefingRow
                        key={`${item.threadId}-${item.messageId ?? index}`}
                        item={item}
                        accounts={accounts}
                        colors={colors}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}

        {rollups && rollups.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {rollups.map((rollup) => {
              const hex = colors?.find((c) => c.accountId === rollup.accountId)?.hex;
              return (
                <p
                  key={`${rollup.accountId ?? "none"}-${rollup.label}`}
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                >
                  {rollup.accountId && <AccountDot color={hex} className="mt-1.5" />}
                  <span>
                    {t("chat.cards.briefing.rollup", { count: rollup.count, label: rollup.label })}
                    {rollup.examples && rollup.examples.length > 0 && (
                      <span className="text-muted-foreground/70">
                        {" "}
                        ({rollup.examples.join(", ")})
                      </span>
                    )}
                  </span>
                </p>
              );
            })}
          </div>
        )}
      </div>
    </CardShell>
  );
}

/**
 * One triaged item. The account chip other cards use is deliberately not
 * here — that's the whole point of the flat cross-account layout — so the
 * account only surfaces as a colour dot, resolved the same way the other
 * cards resolve theirs (`colors` by `accountId`).
 */
function BriefingRow({
  item,
  accounts,
  colors,
}: {
  item: BriefingItem;
  accounts?: CardAccount[];
  colors?: AccountColor[];
}) {
  const { t } = useTranslation();
  const account = accounts?.find((a) => a.accountId === item.accountId);
  const hex = colors?.find((c) => c.accountId === item.accountId)?.hex;
  const urgent = item.priority === "urgent";
  const subject = item.subject || t("chat.cards.noSubject");
  const webUrl = item.webUrl;

  const draftReply = () => {
    const text = account
      ? t("chat.cards.briefing.draftReplyPrompt", {
          sender: item.sender,
          subject,
          account: account.name,
          threadId: item.threadId,
          gist: item.gist,
        })
      : t("chat.cards.briefing.draftReplyPromptNoAccount", {
          sender: item.sender,
          subject,
          threadId: item.threadId,
          gist: item.gist,
        });
    dispatchQuickAction(text);
  };

  const reviewDraft = () => {
    dispatchQuickAction(
      t("chat.cards.briefing.reviewDraftPrompt", {
        sender: item.sender,
        subject,
        threadId: item.threadId,
        draftId: item.draftId ?? "",
      }),
    );
  };

  const askAbout = () => {
    dispatchQuickAction(
      t("chat.cards.briefing.askAboutPrompt", {
        sender: item.sender,
        subject,
        threadId: item.threadId,
        gist: item.gist,
      }),
    );
  };

  return (
    <div
      className={cn(
        "group -mx-2 flex items-start gap-2 rounded-lg px-2 py-1.5",
        urgent && "tint-warning",
      )}
    >
      {/* Colour alone can't carry which inbox a row came from — the one thing
          this cross-account layout trades away for density. The dot stays
          decorative; the account name rides along for assistive tech. */}
      <span className="mt-[7px] shrink-0" data-tooltip={account?.name}>
        <AccountDot color={hex} className="block" />
        {account && <span className="sr-only">{account.name}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed">
          {urgent && (
            <AlertTriangle className="mr-1 -mt-0.5 inline-block h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-medium">{item.sender}</span> {subject}
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span className="text-muted-foreground">{item.gist}</span>
        </p>
        {(item.deadline || item.draftId) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {item.deadline && (
              <Badge variant="muted" className="gap-1">
                <Clock className="h-3 w-3" aria-hidden />
                {item.deadline}
              </Badge>
            )}
            {item.draftId && <Badge variant="success">{t("chat.cards.briefing.draftReady")}</Badge>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {webUrl && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => openExternal(webUrl)}
            title={t("chat.cards.draft.open")}
            aria-label={t("chat.cards.draft.open")}
          >
            <ExternalLink />
          </Button>
        )}
        {item.draftId ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={reviewDraft}
            data-tooltip={t("chat.cards.briefing.reviewDraft")}
            aria-label={t("chat.cards.briefing.reviewDraft")}
          >
            <Eye />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={draftReply}
            data-tooltip={t("chat.cards.briefing.draftReply")}
            aria-label={t("chat.cards.briefing.draftReply")}
          >
            <PenLine />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={askAbout}
          data-tooltip={t("chat.cards.briefing.askAbout")}
          aria-label={t("chat.cards.briefing.askAbout")}
        >
          <MessageCircleQuestion />
        </Button>
      </div>
    </div>
  );
}
