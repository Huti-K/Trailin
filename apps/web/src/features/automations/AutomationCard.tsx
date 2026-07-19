import type { Automation, AutomationRun } from "@trailin/shared";
import { ChevronDown, ChevronUp, Pin, Play } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { OpenRunInChatButton } from "@/components/OpenRunInChatButton";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { LoadingRow } from "@/components/ui/feedback";
import { Markdown } from "@/components/ui/markdown";
import { Switch } from "@/components/ui/switch";
import { scheduleLabel } from "@/features/automations/schedule";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/dates";
import { useServerEvents } from "@/lib/serverEvents";
import { toast } from "@/lib/toast";
import { cn, toggleRowProps } from "@/lib/utils";

/**
 * One automation on the Automations page: name, schedule badge, pause/pin
 * controls, "Run now", and its recent runs behind a disclosure. Editing goes
 * through the panel's shared form dialog (the onEdit callback).
 */
export function AutomationCard({
  automation,
  flash,
  onChanged,
  onEdit,
}: {
  automation: Automation;
  /** Play the one-shot arrival flash — set when another panel navigated here to this card. */
  flash?: boolean;
  onChanged: () => Promise<void>;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [runs, setRuns] = React.useState<AutomationRun[] | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const label = scheduleLabel(automation.schedule, t, i18n.language);

  const loadRuns = React.useCallback(async () => {
    setRuns(await api.automationRuns(automation.id).catch(() => []));
  }, [automation.id]);

  React.useEffect(() => {
    if (expanded) void loadRuns();
  }, [expanded, loadRuns]);

  // Keep polling while a run is in flight so "running" resolves on screen.
  React.useEffect(() => {
    if (!expanded || !runs?.some((r) => r.status === "running")) return;
    const timer = setInterval(() => void loadRuns(), 2000);
    return () => clearInterval(timer);
  }, [expanded, runs, loadRuns]);

  // Complements the polling: run started/finished elsewhere (schedule, chat).
  useServerEvents(["runs"], () => {
    if (expanded) void loadRuns();
  });

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.updateAutomation(automation.id, { enabled });
      await onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  // Pinning is exclusive server-side (setting one unpins any other), so a
  // plain refetch after either direction is enough to keep every row in sync.
  const togglePin = async () => {
    setBusy(true);
    try {
      await api.setAutomationPinned(automation.id, !automation.pinned);
      await onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      await api.runAutomation(automation.id);
      setExpanded(true);
      // Give the run a moment to be recorded before the first poll.
      setTimeout(() => void loadRuns(), 800);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg" className={cn(flash && "flash-accent")}>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="block min-w-0 flex-1 rounded-md text-left transition-opacity hover:opacity-80"
        >
          <div className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight">
            {automation.name}
            <Badge
              variant="muted"
              className={cn("text-2xs", !label && "font-mono")}
              title={automation.schedule}
            >
              {label ?? automation.schedule}
            </Badge>
            {!automation.enabled && <Badge variant="warning">{t("automations.paused")}</Badge>}
            {!automation.showInActivity && (
              <Badge variant="muted">{t("automations.hiddenFromActivity")}</Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {automation.instruction}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void togglePin()}
            disabled={busy}
            data-tooltip={automation.pinned ? t("automations.pinned") : t("automations.pin")}
            aria-label={automation.pinned ? t("automations.pinned") : t("automations.pin")}
          >
            <Pin
              className={cn(
                "h-4 w-4",
                automation.pinned ? "fill-accent/25 text-accent" : "text-muted-foreground",
              )}
            />
          </Button>
          <Switch
            checked={automation.enabled}
            onCheckedChange={(v) => void toggle(v)}
            disabled={busy}
            aria-label={t("automations.paused")}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-4 pt-1">
        <DisclosureToggle open={expanded} onToggle={() => setExpanded((v) => !v)}>
          {t("automations.recentRuns")}
        </DisclosureToggle>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={busy}>
            <Play className="h-3.5 w-3.5 mr-1.5" /> {t("automations.runNow")}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          {!runs ? (
            <LoadingRow />
          ) : runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("automations.noRuns")}</p>
          ) : (
            runs.map((run) => <RunItem key={run.id} run={run} />)
          )}
        </div>
      )}
    </Card>
  );
}

function RunItem({ run }: { run: AutomationRun }) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = React.useState(false);
  const hasResult = !!run.result;

  const toggleExpanded = () => setExpanded(!expanded);

  return (
    <div className="rounded-lg bg-surface-2 p-3">
      <div
        className={cn("flex items-center gap-2", hasResult && "cursor-pointer")}
        {...(hasResult ? toggleRowProps(expanded, toggleExpanded) : {})}
      >
        {hasResult &&
          (expanded ? (
            <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ))}
        <RunStatusBadge status={run.status} />
        <div className="ml-auto flex items-center gap-2">
          <time dateTime={run.startedAt} className="text-xs text-muted-foreground">
            {dateTimeLabel(run.startedAt, i18n.language)}
          </time>
          <OpenRunInChatButton runId={run.id} onNavigateToChat={() => navigate("/chat")} />
        </div>
      </div>
      {expanded && hasResult && <Markdown content={run.result} className="mt-2 text-xs" />}
    </div>
  );
}
