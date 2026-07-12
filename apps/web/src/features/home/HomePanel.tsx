import type {
  AccountColor,
  AccountDrafts,
  Automation,
  OpenConversations,
  RunFeedItem,
} from "@trailin/shared";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  FileText,
  Mail,
  MessageSquareShare,
  Newspaper,
  Wrench,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { AccountDot } from "@/components/ui/account-dot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner, LoadingRow } from "@/components/ui/feedback";
import { Select } from "@/components/ui/select";
import { DigestView, hasDigestShape, parseDigest } from "@/features/automations/DigestView";
import { BriefingHero, findBriefingCard } from "@/features/home/BriefingHero";
import { CollapsibleSectionTitle } from "@/features/home/CollapsibleSectionTitle";
import { DraftRow } from "@/features/home/DraftRow";
import { GlanceStrip } from "@/features/home/GlanceStrip";
import { OpenConversationsSection } from "@/features/home/OpenConversationsSection";
import { api } from "@/lib/api";
import {
  dateTimeLabel,
  dayLabel as formatDayLabel,
  timeLabel as formatTimeLabel,
} from "@/lib/dates";
import type { View } from "@/lib/nav";
import { takePendingDraftFocus } from "@/lib/paletteFocus";
import { openRunInChat } from "@/lib/runNavigation";
import { useServerEvents } from "@/lib/serverEvents";
import { cn, errorMessage } from "@/lib/utils";

/** Widening windows for the "Needs your review" drafts filter; defaults to "today". */
type DraftRange = "today" | "7d" | "30d" | "all";

/** Whether a draft's timestamp falls within the selected range. Drafts with a
 * missing/unparseable date are never hidden, since we can't place them in time. */
function draftInRange(dateIso: string, range: DraftRange): boolean {
  if (range === "all" || !dateIso) return true;
  const t = new Date(dateIso).getTime();
  if (Number.isNaN(t)) return true;
  const now = Date.now();
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return t >= start.getTime();
  }
  const days = range === "7d" ? 7 : 30;
  return t >= now - days * 24 * 60 * 60 * 1000;
}

/** GET /api/runs/pinned's shape: the pinned automation and its latest
 *  successful run, or both null when nothing is pinned. */
type PinnedRun = { run: RunFeedItem | null; automation: Automation | null };

/**
 * Stale-while-revalidate cache. The Home route unmounts when you navigate away
 * (React Router swaps the route element), so without this every return to Home
 * re-fetches from scratch and flashes a spinner. Seeding state from the last
 * known data lets the page paint instantly while `load()` refreshes in the
 * background. Module-level so it survives the component's unmount/remount.
 */
const cache: {
  drafts: AccountDrafts[] | null;
  runs: RunFeedItem[] | null;
  automations: Automation[] | null;
  colors: AccountColor[];
  waiting: OpenConversations | null;
  pinned: PinnedRun | null;
} = { drafts: null, runs: null, automations: null, colors: [], waiting: null, pinned: null };

/**
 * The default view: what the agent prepared for you (drafts to review) and
 * what it has been doing (automation runs), on one page.
 */
export function HomePanel({
  setupIncomplete,
  offline,
  onNavigate,
}: {
  setupIncomplete: boolean;
  /** Pipedream is configured but the last account list couldn't be fetched. */
  offline: boolean;
  onNavigate: (view: View) => void;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = React.useState<AccountDrafts[] | null>(cache.drafts);
  const [runs, setRuns] = React.useState<RunFeedItem[] | null>(cache.runs);
  const [automations, setAutomations] = React.useState<Automation[] | null>(cache.automations);
  const [colors, setColors] = React.useState<AccountColor[]>(cache.colors);
  const [waiting, setWaiting] = React.useState<OpenConversations | null>(cache.waiting);
  const [pinned, setPinned] = React.useState<PinnedRun | null>(cache.pinned);
  const [error, setError] = React.useState<string | null>(null);
  // Set by the search palette (see SearchPalette.tsx) when a draft hit is opened.
  const [focusDraft, setFocusDraft] = React.useState<{ accountId: string; draftId: string } | null>(
    null,
  );

  // Bumped on every load() call so a stale in-flight load — this refetches on
  // server-sent events and can overlap a newer call — never applies its
  // results or error banner after a fresher one has started.
  const loadToken = React.useRef(0);

  const load = React.useCallback(async () => {
    setError(null);
    const token = ++loadToken.current;
    const isCurrent = () => loadToken.current === token;

    // Applies each result to its state setter and the cache the instant its
    // own promise settles, instead of waiting on the slowest of the six —
    // drafts fans out to live mailbox APIs and can take several seconds cold
    // while the rest are fast local-DB reads.
    const apply = <T,>(promise: Promise<T>, onFulfilled: (value: T) => void) =>
      promise.then((value) => {
        if (isCurrent()) onFulfilled(value);
      });

    const results = await Promise.allSettled([
      apply(api.drafts(), (v) => {
        cache.drafts = v;
        setDrafts(v);
      }),
      apply(api.runsFeed(), (v) => {
        cache.runs = v.items;
        setRuns(v.items);
      }),
      apply(api.automations(), (v) => {
        cache.automations = v;
        setAutomations(v);
      }),
      apply(api.accountColors(), (v) => {
        cache.colors = v.colors;
        setColors(v.colors);
      }),
      apply(api.waiting(), (v) => {
        cache.waiting = v;
        setWaiting(v);
      }),
      apply(api.pinnedRun(), (v) => {
        cache.pinned = v;
        setPinned(v);
      }),
    ]);

    if (!isCurrent()) return;
    const failed = results.find((x) => x.status === "rejected");
    setError(failed ? errorMessage(failed.reason) : null);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Refetch in place when the agent or an automation changes data server-side.
  useServerEvents(["runs", "drafts", "automations"], () => void load());

  // The search palette navigates here, then dispatches this with the hit's
  // ids — but only once this effect's listener is attached, which loses the
  // race when Home wasn't already mounted. Catch that case by also reading
  // the same payload stashed just before navigate (see lib/paletteFocus.ts).
  React.useEffect(() => {
    const pending = takePendingDraftFocus();
    if (pending) setFocusDraft(pending);
    const onOpenDraft = (e: Event) => {
      const detail = (e as CustomEvent<{ accountId: string; draftId: string }>).detail;
      if (detail) setFocusDraft(detail);
      // Already handled live — discard so a later remount doesn't replay it.
      takePendingDraftFocus();
    };
    window.addEventListener("trailin:open-draft", onOpenDraft);
    return () => window.removeEventListener("trailin:open-draft", onOpenDraft);
  }, []);

  // The flagship output: the pinned automation's latest successful run, when
  // one is pinned. Otherwise fall back to the most recent successful,
  // briefing-shaped run across all automations, so installs with nothing
  // pinned yet behave exactly as before pinning existed. Sorted explicitly
  // rather than trusting feed order, since that's a server-side detail this
  // component shouldn't depend on.
  //
  // A run qualifies two ways, matching BriefingHero's own render fallback: it
  // carries a structured briefing card, or — for runs predating
  // compose_briefing — its result text still parses as a markdown digest.
  // Checking only the latter would hide every new briefing, whose closing
  // text is now a couple of prose sentences rather than the digest itself.
  const heroRun = React.useMemo(() => {
    if (pinned?.run) return pinned.run;
    if (!runs) return null;
    let best: RunFeedItem | null = null;
    for (const run of runs) {
      if (run.status !== "success") continue;
      const isBriefing =
        !!findBriefingCard(run) || (!!run.result && hasDigestShape(parseDigest(run.result)));
      if (!isBriefing) continue;
      if (!best || new Date(run.startedAt).getTime() > new Date(best.startedAt).getTime()) {
        best = run;
      }
    }
    return best;
  }, [runs, pinned]);

  // Keep `runs` as-is while loading (null) so ActivitySection still shows its
  // own loading state; once loaded, drop the run already shown in the hero.
  const activityRuns = React.useMemo(() => {
    if (!runs) return runs;
    return heroRun ? runs.filter((r) => r.id !== heroRun.id) : runs;
  }, [runs, heroRun]);

  // No top-level loading gate: each section renders its own <LoadingRow /> while
  // its data is null, so the fast local reads (runs/automations) paint straight
  // away instead of waiting on the slow live mailbox drafts fetch.
  return (
    <div className="flex flex-col gap-10 pt-1">
      {error && !offline && <ErrorBanner>{error}</ErrorBanner>}

      {setupIncomplete ? (
        <div className="tint-warning flex flex-wrap items-center justify-between gap-3 rounded-lg p-3.5">
          <p className="text-sm">{t("home.setupBanner")}</p>
          <Button size="sm" onClick={() => onNavigate("settings")}>
            {t("home.setupBannerCta")}
          </Button>
        </div>
      ) : (
        offline && (
          <div className="tint-warning flex items-center gap-3 rounded-lg p-3.5">
            <p className="text-sm">{t("home.offlineBanner")}</p>
          </div>
        )
      )}

      <GlanceStrip drafts={drafts} heroRun={heroRun} waiting={waiting} automations={automations} />

      {heroRun && (
        <BriefingHero
          run={heroRun}
          runs={runs}
          onNavigate={onNavigate}
          colors={colors}
          nextRunAt={
            pinned?.automation?.nextRunAt ??
            automations?.find((a) => a.id === heroRun.automationId)?.nextRunAt
          }
        />
      )}

      <ReviewSection
        drafts={drafts}
        colors={colors}
        onChanged={() => void load()}
        focusDraft={focusDraft}
      />
      <OpenConversationsSection waiting={waiting} colors={colors} />
      <ActivitySection
        runs={activityRuns}
        automations={automations}
        onNavigate={onNavigate}
        hasHero={!!heroRun}
      />
    </div>
  );
}

/* ---------------- Drafts waiting for review ---------------- */

function ReviewSection({
  drafts,
  colors,
  onChanged,
  focusDraft,
}: {
  drafts: AccountDrafts[] | null;
  colors: AccountColor[];
  onChanged: () => void;
  /** A draft opened via the search palette — widen the filter and expand so it's visible. */
  focusDraft?: { accountId: string; draftId: string } | null;
}) {
  const { t, i18n } = useTranslation();
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [range, setRange] = React.useState<DraftRange>("today");
  const [isExpanded, setIsExpanded] = React.useState(true);

  React.useEffect(() => {
    if (!focusDraft) return;
    setRange("all");
    setIsExpanded(true);
  }, [focusDraft]);

  const dateLabel = (iso: string) => dateTimeLabel(iso, i18n.language);

  const unfilteredTotal = drafts?.reduce((n, a) => n + a.drafts.length, 0) ?? 0;
  // An account with a fetch error contributes 0 drafts, so unfiltered/filteredTotal
  // alone can't be trusted to mean "nothing to show" — that would swallow the error.
  const hasErroredAccount = drafts?.some((a) => a.error) ?? false;

  const filteredAccounts: AccountDrafts[] =
    drafts?.map((a) => ({ ...a, drafts: a.drafts.filter((d) => draftInRange(d.date, range)) })) ??
    [];
  const filteredTotal = filteredAccounts.reduce((n, a) => n + a.drafts.length, 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <CollapsibleSectionTitle
          icon={FileText}
          title={t("home.reviewTitle")}
          count={filteredTotal}
          expanded={isExpanded}
          onToggle={() => setIsExpanded(!isExpanded)}
        />
        {unfilteredTotal > 0 && (
          <Select
            id="draft-range"
            value={range}
            onChange={(v) => setRange(v as DraftRange)}
            aria-label={t("home.filterPeriod")}
            className="w-auto"
            options={[
              { value: "today", label: t("home.filterToday") },
              { value: "7d", label: t("home.filter7Days") },
              { value: "30d", label: t("home.filter30Days") },
              { value: "all", label: t("home.filterAll") },
            ]}
          />
        )}
      </div>

      {isExpanded && (
        <div className="flex flex-col gap-3">
          {rowError && <ErrorBanner>{rowError}</ErrorBanner>}

          {!drafts ? (
            <LoadingRow />
          ) : (unfilteredTotal === 0 || filteredTotal === 0) && !hasErroredAccount ? (
            <p className="rounded-lg bg-surface-2 px-3.5 py-3 text-xs text-muted-foreground">
              {t(unfilteredTotal === 0 ? "home.reviewEmpty" : "home.reviewEmptyFiltered")}
            </p>
          ) : (
            <div className="flex flex-col gap-8">
              {filteredAccounts
                .filter((a) => a.drafts.length > 0 || a.error)
                .map((accountDrafts) => (
                  <div key={accountDrafts.accountId} className="flex flex-col gap-3">
                    {filteredAccounts.length > 1 && (
                      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <AccountDot
                          className="h-2.5 w-2.5"
                          color={colors.find((c) => c.accountId === accountDrafts.accountId)?.hex}
                        />
                        <Mail className="h-3.5 w-3.5" />
                        {accountDrafts.account}
                        <span className="text-muted-foreground/70">
                          · {accountDrafts.drafts.length}
                        </span>
                      </h3>
                    )}
                    {accountDrafts.error ? (
                      <ErrorBanner>{accountDrafts.error}</ErrorBanner>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {accountDrafts.drafts.map((draft, i) => (
                          <div
                            key={draft.id}
                            className="animate-in-up"
                            style={{ animationDelay: `${i * 45}ms` }}
                          >
                            <DraftRow
                              accountId={accountDrafts.accountId}
                              draft={draft}
                              dateLabel={dateLabel}
                              onDeleted={onChanged}
                              onSaved={onChanged}
                              onError={setRowError}
                              forceOpen={
                                focusDraft?.accountId === accountDrafts.accountId &&
                                focusDraft?.draftId === draft.id
                              }
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- What the agent has been doing ---------------- */

function ActivitySection({
  runs,
  automations,
  onNavigate,
  hasHero,
}: {
  runs: RunFeedItem[] | null;
  automations: Automation[] | null;
  onNavigate: (view: View) => void;
  /** The latest digest already leads the page as the BriefingHero — don't also auto-expand it here. */
  hasHero: boolean;
}) {
  const { t, i18n } = useTranslation();
  // Older runs stay collapsed behind this toggle; only today's ever show by
  // default so the section doesn't grow unbounded with automation history.
  const [showEarlier, setShowEarlier] = React.useState(false);

  const dayLabel = (iso: string) => formatDayLabel(iso, i18n.language);
  const timeLabel = (iso: string) => formatTimeLabel(iso, i18n.language);
  const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

  const groupByDay = (list: RunFeedItem[]) => {
    const byDay = new Map<string, RunFeedItem[]>();
    for (const run of list) {
      const key = dayLabel(run.startedAt);
      byDay.set(key, [...(byDay.get(key) ?? []), run]);
    }
    return byDay;
  };

  const todayRuns = (runs ?? []).filter((r) => isToday(r.startedAt));
  const earlierRuns = (runs ?? []).filter((r) => !isToday(r.startedAt));
  // `runs` arrives newest-first from the feed, so its head is the one card
  // that was expanded by default before today/earlier existed as separate
  // groups — preserve that regardless of which group it lands in.
  const firstRunId = runs?.[0]?.id;

  const hasAutomations = (automations?.length ?? 0) > 0;

  const renderDayGroups = (list: RunFeedItem[]) => (
    <div className="flex flex-col gap-8">
      {[...groupByDay(list).entries()].map(([day, dayRuns]) => (
        <div key={day} className="flex flex-col gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {day}
          </h3>
          <div className="flex flex-col gap-3">
            {dayRuns.map((run, i) => (
              <ActivityRunCard
                key={run.id}
                run={run}
                index={i}
                timeLabel={timeLabel}
                defaultExpanded={!hasHero && run.id === firstRunId}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
          <div className="tint-accent flex h-7 w-7 items-center justify-center rounded-md">
            <Wrench className="h-4 w-4" />
          </div>
          {t("home.activityTitle")}
        </h2>
      </div>

      {!runs ? (
        <LoadingRow />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Newspaper}
          title={t("home.activityEmptyTitle")}
          description={hasAutomations ? t("home.activityNoRunsBody") : t("home.activityEmptyBody")}
          action={
            <Button size="sm" onClick={() => onNavigate("automations")}>
              <CalendarClock />
              {hasAutomations ? t("home.viewAutomations") : t("home.createAutomation")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {todayRuns.length > 0 ? (
            renderDayGroups(todayRuns)
          ) : earlierRuns.length > 0 ? (
            <p className="text-xs text-muted-foreground">{t("home.activityNothingToday")}</p>
          ) : null}

          {earlierRuns.length > 0 && (
            <div className="flex flex-col gap-4">
              {showEarlier && renderDayGroups(earlierRuns)}
              <DisclosureToggle open={showEarlier} onToggle={() => setShowEarlier((v) => !v)}>
                {showEarlier
                  ? t("home.activityShowLess")
                  : t("home.activityShowEarlier", { count: earlierRuns.length })}
              </DisclosureToggle>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ActivityRunCard({
  run,
  index,
  timeLabel,
  defaultExpanded = false,
  onNavigate,
}: {
  run: RunFeedItem;
  index: number;
  timeLabel: (iso: string) => string;
  defaultExpanded?: boolean;
  onNavigate: (view: View) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const hasResult = !!run.result;
  const toggleExpanded = () => setExpanded(!expanded);

  return (
    <Card
      as="article"
      className="animate-in-up flex flex-col gap-3"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div
        className={cn("flex items-center justify-between gap-3", hasResult && "cursor-pointer")}
        {...(hasResult
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-expanded": expanded,
              onClick: toggleExpanded,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleExpanded();
                }
              },
            }
          : {})}
      >
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{run.automationName ?? t("home.deletedAutomation")}</span>
          {hasResult &&
            (expanded ? (
              <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ))}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("home.openInChat")}
            aria-label={t("home.openInChat")}
            onClick={(e) => {
              e.stopPropagation();
              openRunInChat(run.id, () => onNavigate("chat"));
            }}
          >
            <MessageSquareShare className="h-3 w-3" />
          </Button>
          <RunStatusBadge status={run.status} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {timeLabel(run.startedAt)}
          </span>
        </div>
      </div>
      {expanded && hasResult && (
        <div className="mt-1 pt-3 border-t border-border">
          <DigestView
            content={run.result}
            automationName={run.automationName}
            runDate={run.startedAt}
            className="text-sm text-foreground/90"
          />
        </div>
      )}
    </Card>
  );
}
