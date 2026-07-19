import type { AccountColor, AgentCard, RunFeedItem } from "@trailin/shared";
import { ChevronDown, ChevronUp, MessageSquareShare, RefreshCw, Sunrise } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { BriefingCard } from "@/components/cards/BriefingCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/feedback";
import { IconChip } from "@/components/ui/icon-chip";
import { Markdown } from "@/components/ui/markdown";
import { api } from "@/lib/api";
import { dayTimeLabel, isToday } from "@/lib/dates";
import type { View } from "@/lib/nav";
import { openRunInChat } from "@/lib/quickActions";
import { cn, errorMessage, toggleRowProps } from "@/lib/utils";

type BriefingCardData = Extract<AgentCard, { kind: "briefing" }>;

/** The run's structured briefing card, if its turn produced one — a run
 *  whose turn never called `compose_briefing` has no card and falls through. */
export function findBriefingCard(run: RunFeedItem): BriefingCardData | undefined {
  const match = run.cards?.find((c) => c.card.kind === "briefing");
  return match ? (match.card as BriefingCardData) : undefined;
}

/** Count of urgent items in a briefing run. Reads the structured card's own
 *  `items`; a run without a card has no urgent count. */
function countUrgentItems(run: RunFeedItem): number {
  const briefing = findBriefingCard(run);
  return briefing ? briefing.items.filter((item) => item.priority === "urgent").length : 0;
}

/**
 * The expanded body of a run card, behind the shared hairline divider: the
 * structured briefing when the run's turn produced one, else the plain
 * markdown result. One shape for the hero and the activity feed, so a run
 * always unfolds the same way.
 */
export function RunBody({
  run,
  colors,
  markdownClassName,
}: {
  run: RunFeedItem;
  colors: AccountColor[];
  markdownClassName?: string;
}) {
  const briefing = findBriefingCard(run);
  return (
    <div className="mt-1 border-t border-border pt-3">
      {briefing ? (
        <BriefingCard card={briefing} colors={colors} bare />
      ) : (
        <Markdown content={run.result} className={markdownClassName} />
      )}
    </div>
  );
}

/**
 * The flagship "Today's briefing" card — the most recent successful,
 * card-carrying automation run (see HomePanel's heroRun selection), shown
 * expanded above the rest of the activity feed. The body renders the
 * structured `BriefingCard` when the run's turn produced one, else the
 * generic plain-markdown render — a run whose turn skipped compose_briefing
 * still renders, just without any briefing-shaped structure.
 */
export function BriefingHero({
  run,
  runs,
  onNavigate,
  nextRunAt,
  colors,
}: {
  run: RunFeedItem;
  /** Full runs feed, used only to detect an already in-flight re-run of this automation. */
  runs?: RunFeedItem[] | null;
  onNavigate: (view: View) => void;
  /** Next scheduled run of this automation (Automation.nextRunAt), shown when this run isn't from today. */
  nextRunAt?: string | null;
  /** HomePanel already fetches and caches these — no need for BriefingHero to fetch its own. */
  colors: AccountColor[];
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const briefingCard = React.useMemo(() => findBriefingCard(run), [run]);
  const urgentCount = React.useMemo(() => countUrgentItems(run), [run]);

  // Cover both "I just clicked refresh" and "a schedule/chat kicked off a run
  // for this automation elsewhere" — either way the spinner should be lit.
  const feedRunning = runs?.some(
    (r) => r.automationId === run.automationId && r.status === "running",
  );
  const isRefreshing = refreshing || !!feedRunning;

  const startedToday = isToday(run.startedAt);
  let metaLabel = startedToday
    ? t("home.briefingToday", { time: dayTimeLabel(run.startedAt, i18n.language) })
    : dayTimeLabel(run.startedAt, i18n.language, "long");

  // Only surface the next scheduled run when this one isn't from today — a
  // fresh today's briefing doesn't need a "next" hint next to it.
  if (!startedToday && nextRunAt) {
    metaLabel += ` · ${t("home.briefingNext", { when: dayTimeLabel(nextRunAt, i18n.language) })}`;
  }

  const refresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRefreshing) return;
    setError(null);
    setRefreshing(true);
    try {
      // Fire-and-forget on the server (202): the run itself takes minutes.
      // `refreshing` stays true past this await — the effect below hands the
      // spinner over once the runs feed reflects the running row, so there is
      // no dead moment between "queued" and "visibly running".
      await api.runAutomation(run.automationId);
    } catch (err) {
      setError(errorMessage(err));
      setRefreshing(false);
    }
  };

  // Hand-off (plus a stuck-spinner backstop): once the feed shows the run,
  // feedRunning owns the spinner; if it never does — dropped event stream,
  // failed run start — give up after a beat rather than spin forever.
  React.useEffect(() => {
    if (!refreshing) return;
    if (feedRunning) {
      setRefreshing(false);
      return;
    }
    const timer = setTimeout(() => setRefreshing(false), 15_000);
    return () => clearTimeout(timer);
  }, [refreshing, feedRunning]);

  const openInChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRunInChat(run.id, () => onNavigate("chat"));
  };

  return (
    <Card as="section" padding="lg" className="animate-in-up flex flex-col gap-3">
      {/* Toggles the card but wraps the real refresh/open-in-chat buttons below —
          a native <button> can't contain them, hence the ARIA toggle-row spread. */}
      <div
        className="flex items-center justify-between gap-3 cursor-pointer"
        {...toggleRowProps(expanded, () => setExpanded(!expanded))}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip>
            <Sunrise />
          </IconChip>
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <span className="truncate">{run.automationName ?? t("home.deletedAutomation")}</span>
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </span>
            <span className="text-xs text-muted-foreground">{metaLabel}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* The briefing card carries this same count in its own stat row, so
              the header badge would double it up. Keep it while collapsed —
              there it's the only urgency signal on screen. */}
          {urgentCount > 0 && !(expanded && briefingCard) && (
            <Badge variant="warning">{t("home.briefingUrgent", { count: urgentCount })}</Badge>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("home.briefingRefresh")}
            disabled={isRefreshing}
            onClick={(e) => void refresh(e)}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("home.openInChat")}
            aria-label={t("home.openInChat")}
            onClick={openInChat}
          >
            <MessageSquareShare className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {expanded && <RunBody run={run} colors={colors} />}
    </Card>
  );
}
