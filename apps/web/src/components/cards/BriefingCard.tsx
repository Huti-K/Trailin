import type {
  AccountColor,
  AgentCard,
  BriefingItem,
  BriefingPriority,
  BriefingRollup,
  CardAccount,
} from "@marlen/shared";
import { BRIEFING_PRIORITIES } from "@marlen/shared";
import { AlertTriangle, Clock, Eye, MessageCircleQuestion, PenLine, Sunrise } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AccountDot } from "@/components/ui/account-dot";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { GroupLabel } from "@/components/ui/group-label";
import { HoverActions } from "@/components/ui/hover-actions";
import { OpenExternalButton } from "@/components/ui/open-external-button";
import { accountColor } from "@/lib/accounts";
import { dispatchQuickAction } from "@/lib/quickActions";
import { cn } from "@/lib/utils";
import { CardShell } from "./CardShell";

/** The row's account marker — a decorative dot resolved from `colors`, with
 *  the account name riding along for assistive tech only. */
function AccountMarker({
  accountId,
  accounts,
  colors,
  className,
  dotClassName,
}: {
  accountId?: string;
  accounts?: CardAccount[];
  colors?: AccountColor[];
  className?: string;
  dotClassName?: string;
}) {
  const account = accounts?.find((a) => a.accountId === accountId);
  return (
    <span className={className} data-tooltip={account?.name}>
      <AccountDot color={accountColor(colors, accountId)} className={dotClassName} />
      {account && <span className="sr-only">{account.name}</span>}
    </span>
  );
}

type BriefingData = Extract<AgentCard, { kind: "briefing" }>;

/**
 * The structured Morning-briefing card — flat and cross-account by design
 * (see apps/web/DESIGN.md and the `kind: "briefing"` doc comment on
 * AgentCard). Priority is the grouping axis, not the inbox: an account only
 * ever shows up as a colour dot on a row. A run whose turn produced no card
 * renders as plain markdown instead (see BriefingHero's degrade).
 */
export function BriefingCard({
  card,
  colors,
  bare,
}: {
  card: BriefingData;
  colors?: AccountColor[];
  /** Skip the CardShell frame — for embedding in an already-elevated panel (BriefingHero), never nest surfaces. */
  bare?: boolean;
}) {
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

  const otherStats: string[] = [];
  if (replyCount > 0) otherStats.push(t("chat.cards.briefing.stats.reply", { count: replyCount }));
  if (draftsReadyCount > 0) {
    otherStats.push(t("chat.cards.briefing.stats.draftsReady", { count: draftsReadyCount }));
  }
  // Rolled-up mail isn't tallied here — each kind renders as its own headed
  // group below, with its own count, so a top-line total would just duplicate.
  if (typeof scanned === "number") {
    otherStats.push(t("chat.cards.briefing.stats.scanned", { count: scanned }));
  }

  const hasStats = urgentCount > 0 || otherStats.length > 0;

  const body = (
    <div className={cn("flex flex-col gap-4", !bare && "px-4 pb-4 pt-0.5")}>
      {(headline || periodLabel) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {headline && <p className="text-sm font-semibold tracking-tight">{headline}</p>}
          {periodLabel && <p className="text-xs text-muted-foreground">{periodLabel}</p>}
        </div>
      )}

      {hasStats && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {urgentCount > 0 && (
            <Badge variant="warning">{t("home.briefingUrgent", { count: urgentCount })}</Badge>
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
                <DisclosureToggle
                  open={fyiOpen}
                  onToggle={() => setFyiOpen((v) => !v)}
                  className="px-0.5 py-0.5 font-semibold uppercase tracking-wide"
                >
                  {fyiOpen
                    ? t("chat.cards.briefing.groups.fyi")
                    : t("chat.cards.briefing.showMore", { count: groupItems.length })}
                </DisclosureToggle>
              ) : (
                <div className="flex items-center gap-1.5 px-0.5">
                  <GroupLabel as="h4">{t(`chat.cards.briefing.groups.${priority}`)}</GroupLabel>
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

      {/* Rolled-up low-value mail: the whole region folds under one toggle, and
          each kind (Newsletters, Receipts…) folds on its own within it.
          Deliberately quieter than the tiers — each message is a compact
          one-line RollupRow, not a full BriefingRow, so the noise never competes
          with the mail that needs the user. */}
      {rollups && rollups.length > 0 && (
        <RollupsSection rollups={rollups} accounts={accounts} colors={colors} />
      )}
    </div>
  );

  if (bare) return body;

  return (
    <CardShell
      icon={Sunrise}
      label={t("chat.cards.briefing.label")}
      meta={
        items.length > 0 ? t("chat.cards.briefing.itemCount", { count: items.length }) : undefined
      }
    >
      {body}
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
  const navigate = useNavigate();
  const account = accounts?.find((a) => a.accountId === item.accountId);
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

  // Jumps straight to the draft's approval row on Home (same ?draft= handoff
  // as the search palette); the chat prompt is the fallback for a card whose
  // item carries no account id.
  const reviewDraft = () => {
    if (item.accountId && item.draftId) {
      navigate({ pathname: "/", search: `?draft=${item.accountId}:${item.draftId}` });
      return;
    }
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
    <div className="group -mx-2 flex items-start gap-2 rounded-lg px-2 py-1.5">
      {/* Colour alone can't carry which inbox a row came from — the one thing
          this cross-account layout trades away for density. */}
      <AccountMarker
        accountId={item.accountId}
        accounts={accounts}
        colors={colors}
        className="mt-[7px] shrink-0"
        dotClassName="block"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed">
          {/* Urgency is a mark on the row, never a fill behind it (DESIGN.md). */}
          {urgent && (
            <AlertTriangle
              className="mr-1 -mt-0.5 inline-block h-3.5 w-3.5 shrink-0 text-warning"
              aria-hidden
            />
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
            {item.draftId && (
              <button
                type="button"
                onClick={reviewDraft}
                className={badgeVariants({ variant: "success" })}
                data-tooltip={t("chat.cards.briefing.reviewDraft")}
                aria-label={t("chat.cards.briefing.reviewDraft")}
              >
                <Eye aria-hidden />
                {t("chat.cards.briefing.draftReady")}
              </button>
            )}
          </div>
        )}
      </div>
      <HoverActions>
        {webUrl && <OpenExternalButton url={webUrl} label={t("chat.cards.draft.open")} />}
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
      </HoverActions>
    </div>
  );
}

/**
 * The whole rolled-up region under one master toggle, on top of each kind
 * group's own toggle — so all the low-value mail folds away in one click, or
 * kind by kind. Open by default: the noise stays visible but is never in the
 * way.
 */
function RollupsSection({
  rollups,
  accounts,
  colors,
}: {
  rollups: BriefingRollup[];
  accounts?: CardAccount[];
  colors?: AccountColor[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(true);
  const total = rollups.reduce((n, r) => n + r.items.length, 0);

  return (
    <div className="flex flex-col gap-2">
      <DisclosureToggle open={open} onToggle={() => setOpen((v) => !v)} className="px-0.5 py-0.5">
        {t("chat.cards.briefing.rolledUp", { count: total })}
      </DisclosureToggle>
      {open && (
        <div className="flex flex-col gap-2 pl-2">
          {rollups.map((rollup) => (
            <RollupGroup key={rollup.label} rollup={rollup} accounts={accounts} colors={colors} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A collapsible group of rolled-up low-value mail of one kind (Newsletters,
 * Receipts…). The heading is a disclosure toggle — open by default, so the mail
 * stays visible, but foldable away when the noise isn't wanted. Mirrors the FYI
 * tier's toggle rather than the plain tier headings.
 */
function RollupGroup({
  rollup,
  accounts,
  colors,
}: {
  rollup: BriefingRollup;
  accounts?: CardAccount[];
  colors?: AccountColor[];
}) {
  const [open, setOpen] = React.useState(true);

  return (
    <div className="flex flex-col gap-1">
      <DisclosureToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className="px-0.5 py-0.5 font-semibold uppercase tracking-wide"
      >
        {rollup.label}
        <span className="font-mono text-2xs tabular-nums text-muted-foreground/70">
          {rollup.items.length}
        </span>
      </DisclosureToggle>
      {open && (
        <div className="flex flex-col">
          {rollup.items.map((item, index) => (
            <RollupRow
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
}

/**
 * One rolled-up low-value message — a compact, quiet counterpart to
 * BriefingRow: smaller type, tighter rows, no urgency mark, deadline/draft
 * badges or draft/ask actions. Its single action is an open-in-webmail button
 * that surfaces on hover, so the noise stays scannable and one click away from
 * the real thing without ever competing with a tier item.
 */
function RollupRow({
  item,
  accounts,
  colors,
}: {
  item: BriefingItem;
  accounts?: CardAccount[];
  colors?: AccountColor[];
}) {
  const { t } = useTranslation();
  const subject = item.subject || t("chat.cards.noSubject");

  return (
    <div className="group -mx-2 flex items-center gap-2 rounded-md px-2 py-1">
      <AccountMarker
        accountId={item.accountId}
        accounts={accounts}
        colors={colors}
        className="shrink-0"
        dotClassName="block h-1.5 w-1.5"
      />
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        <span className="font-medium text-foreground/75">{item.sender}</span>
        <span className="mx-1.5 text-muted-foreground/40">·</span>
        {subject}
      </p>
      {item.webUrl && (
        <HoverActions>
          <OpenExternalButton
            url={item.webUrl}
            label={t("chat.cards.draft.open")}
            className="h-5 w-5 text-muted-foreground [&_svg]:size-3"
          />
        </HoverActions>
      )}
    </div>
  );
}
