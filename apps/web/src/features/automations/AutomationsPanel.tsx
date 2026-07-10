import * as React from "react";
import { CalendarClock, ChevronDown, ChevronUp, Loader2, MessageSquareShare, Pencil, Pin, Play, Plus, Trash2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { Automation, AutomationRun } from "@trailin/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { DigestView } from "@/features/automations/DigestView";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { LinkButton } from "@/components/ui/link-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { openRunInChat } from "@/lib/runNavigation";
import { toast } from "@/lib/toast";
import { useServerEvents } from "@/lib/serverEvents";
import { cn, errorMessage } from "@/lib/utils";
import {
  DEFAULT_PRESET,
  buildCron,
  daysInMonth,
  monthDayLabel,
  monthName,
  parseCron,
  weekdayName,
  weekdayShortName,
  type SchedulePreset,
} from "@/features/automations/schedule";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Soft format hint for the common numeric 5-field cron form. The server
// (node-cron) is the authority and accepts more — names, 6 fields — so this
// only drives the inline hint, never blocks submission.
const CRON_FIELD = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/;
function looksLikeCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

export function AutomationsPanel() {
  const { t, i18n } = useTranslation();
  const [automations, setAutomations] = React.useState<Automation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showForm, setShowForm] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", instruction: "", showInActivity: true });
  const [preset, setPreset] = React.useState<SchedulePreset>(DEFAULT_PRESET);
  const [cron, setCron] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // Shown once when leaving Advanced discards a cron the picker can't express.
  const [lossNote, setLossNote] = React.useState(false);

  const schedule = advanced ? cron : buildCron(preset);
  const cronValid = looksLikeCron(cron);
  const scheduleValid = advanced
    ? cron.trim().length > 0
    : preset.frequency !== "custom" || preset.weekdays.length > 0;

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setAutomations(await api.automations());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Server-side changes (agent tools, scheduled runs): refetch without the
  // loading gate — toggling it would unmount the cards and drop their state.
  useServerEvents(["automations"], () => {
    void api.automations().then(setAutomations).catch(() => {});
  });

  const resetForm = () => {
    setForm({ name: "", instruction: "", showInActivity: true });
    setPreset(DEFAULT_PRESET);
    setCron("");
    setAdvanced(false);
    setLossNote(false);
  };

  const handleOpenChange = (open: boolean) => {
    setShowForm(open);
    if (!open) {
      resetForm();
      setEditingId(null);
    }
  };

  const toggleAdvanced = () => {
    if (!advanced) {
      // Carry the picker's schedule into the cron field.
      setCron(buildCron(preset));
      setAdvanced(true);
      setLossNote(false);
      return;
    }
    // Back to the picker: adopt the cron when it's expressible, else keep the
    // previous preset and say that the custom cron is being replaced.
    const parsed = parseCron(cron);
    if (parsed) {
      setPreset(parsed);
      setLossNote(false);
    } else {
      setLossNote(cron.trim() !== "");
    }
    setAdvanced(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editingId) {
        await api.updateAutomation(editingId, { ...form, schedule });
      } else {
        await api.createAutomation({ ...form, schedule });
      }
      handleOpenChange(false);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await api.deleteAutomation(editingId);
      handleOpenChange(false);
      setConfirmDelete(false);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openForEdit = (automation: Automation) => {
    setForm({
      name: automation.name,
      instruction: automation.instruction,
      showInActivity: automation.showInActivity,
    });
    const parsed = parseCron(automation.schedule);
    if (parsed) {
      setPreset(parsed);
      setCron("");
      setAdvanced(false);
    } else {
      setPreset(DEFAULT_PRESET);
      setCron(automation.schedule);
      setAdvanced(true);
    }
    setEditingId(automation.id);
    setShowForm(true);
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus /> {t("automations.new")}
        </Button>
      </div>

      <Dialog
        open={showForm}
        onOpenChange={handleOpenChange}
        title={t("automations.formTitle")}
        description={t("automations.formHint")}
        footer={
          <div className="flex w-full items-center justify-between">
            {editingId ? (
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                {t("automations.delete")}
              </Button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={
                  saving ||
                  !form.name.trim() ||
                  !form.instruction.trim() ||
                  !schedule.trim() ||
                  !scheduleValid
                }
              >
                {saving && <Loader2 className="animate-spin" />}
                {editingId ? t("automations.save") : t("automations.create")}
              </Button>
            </div>
          </div>
        }
      >
        <FormField id="automation-name" label={t("automations.name")}>
          <Input
            id="automation-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("automations.namePlaceholder")}
          />
        </FormField>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-frequency">{t("automations.schedule")}</Label>
          {advanced ? (
            <>
              <Input
                id="automation-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 8 * * 1-5"
                aria-invalid={!cronValid}
                className={cn(
                  "font-mono tabular",
                  !cronValid && cron.trim() && "text-destructive",
                )}
              />
              {cron.trim() && !cronValid ? (
                <p className="text-xs text-destructive">{t("automations.cronInvalid")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  <Trans
                    i18nKey="automations.cronHint"
                    components={{ c: <span className="font-mono" /> }}
                  />
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-44">
                  <Select
                    id="automation-frequency"
                    value={preset.frequency}
                    onChange={(value) =>
                      setPreset({ ...preset, frequency: value as SchedulePreset["frequency"] })
                    }
                    options={[
                      { value: "daily", label: t("automations.frequency.daily") },
                      { value: "weekdays", label: t("automations.frequency.weekdays") },
                      { value: "custom", label: t("automations.frequency.custom") },
                      { value: "date", label: t("automations.frequency.date") },
                    ]}
                  />
                </div>
                <Input
                  type="time"
                  value={preset.time}
                  onChange={(e) => setPreset({ ...preset, time: e.target.value || "08:00" })}
                  className="w-28 tabular-nums"
                  aria-label={t("automations.time")}
                />
              </div>

              {preset.frequency === "custom" && (
                <>
                  <WeekdayToggle
                    value={preset.weekdays}
                    onChange={(weekdays) => setPreset({ ...preset, weekdays })}
                    locale={i18n.language}
                  />
                  {preset.weekdays.length === 0 && (
                    <p className="text-xs text-warning">{t("automations.customDaysRequired")}</p>
                  )}
                </>
              )}

              {preset.frequency === "date" && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-36">
                    <Select
                      id="automation-month"
                      aria-label={t("automations.month")}
                      value={String(preset.month)}
                      onChange={(value) => {
                        const month = Number(value);
                        const maxDay = daysInMonth(month);
                        setPreset((p) => ({ ...p, month, day: Math.min(p.day, maxDay) }));
                      }}
                      options={Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ({
                        value: String(m),
                        label: monthName(m, i18n.language),
                      }))}
                    />
                  </div>
                  <div className="w-20">
                    <Select
                      id="automation-day"
                      aria-label={t("automations.day")}
                      value={String(preset.day)}
                      onChange={(value) => setPreset({ ...preset, day: Number(value) })}
                      options={Array.from({ length: daysInMonth(preset.month) }, (_, i) => ({
                        value: String(i + 1),
                        label: String(i + 1),
                      }))}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          {lossNote && !advanced && (
            <p className="text-xs text-warning">{t("automations.advancedLossNote")}</p>
          )}
          {!advanced && preset.frequency === "date" && (
            <p className="text-xs text-muted-foreground">{t("automations.dateOnceHint")}</p>
          )}
          <LinkButton onClick={toggleAdvanced}>
            {advanced ? t("automations.simpleToggle") : t("automations.advancedToggle")}
          </LinkButton>
        </div>

        <FormField id="automation-instruction" label={t("automations.instruction")}>
          <Textarea
            id="automation-instruction"
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder={t("automations.instructionPlaceholder")}
            rows={3}
          />
        </FormField>

        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="automation-activity">{t("automations.showInActivity")}</Label>
            <p className="text-xs text-muted-foreground">{t("automations.showInActivityHint")}</p>
          </div>
          <Switch
            id="automation-activity"
            checked={form.showInActivity}
            onCheckedChange={(v) => setForm({ ...form, showInActivity: v })}
            aria-label={t("automations.showInActivity")}
          />
        </div>
      </Dialog>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} padding="lg">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </Card>
          ))}
        </div>
      ) : automations.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={t("automations.emptyTitle")}
          description={t("automations.emptyBody")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((automation, i) => (
            <div
              key={automation.id}
              className="animate-in-up"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <AutomationCard automation={automation} onChanged={refresh} onEdit={() => openForEdit(automation)} />
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("automations.delete")}
        description={t("automations.deleteConfirm", { name: form.name })}
        confirmLabel={t("automations.delete")}
        variant="destructive"
        busy={saving}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** "Weekdays · 08:00"-style label; null when the cron isn't picker-shaped. */
function scheduleLabel(
  schedule: string,
  t: ReturnType<typeof useTranslation>["t"],
  locale: string,
): string | null {
  const preset = parseCron(schedule);
  if (!preset) return null;
  switch (preset.frequency) {
    case "daily":
      return t("automations.scheduleLabel.daily", { time: preset.time });
    case "weekdays":
      return t("automations.scheduleLabel.weekdays", { time: preset.time });
    case "custom":
      return t("automations.scheduleLabel.custom", {
        days: preset.weekdays.map((d) => weekdayShortName(d, locale)).join(", "),
        time: preset.time,
      });
    case "date":
      return t("automations.scheduleLabel.date", {
        date: monthDayLabel(preset.month, preset.day, locale),
        time: preset.time,
      });
  }
}

/** Multi-select day-of-week chips, Mon→Sun, used by the "custom" schedule. */
function WeekdayToggle({
  value,
  onChange,
  locale,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  locale: string;
}) {
  const toggle = (day: number) => {
    onChange(
      value.includes(day)
        ? value.filter((d) => d !== day)
        : [...value, day].sort((a, b) => a - b),
    );
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_ORDER.map((day) => {
        const active = value.includes(day);
        return (
          <Chip
            key={day}
            active={active}
            onClick={() => toggle(day)}
            aria-label={weekdayName(day, locale)}
            className="h-8 min-w-8 justify-center"
          >
            {weekdayShortName(day, locale)}
          </Chip>
        );
      })}
    </div>
  );
}

function AutomationCard({
  automation,
  onChanged,
  onEdit,
}: {
  automation: Automation;
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
      toast.error(errorMessage(err));
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
      toast.error(errorMessage(err));
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
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-3">
        <div 
          className="min-w-0 flex-1 cursor-pointer rounded-md transition-opacity hover:opacity-80"
          onClick={onEdit}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && onEdit()}
        >
            <div className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight">
              {automation.name}
              <Badge
                variant="muted"
                className={cn("text-[11px]", !label && "font-mono")}
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
          </div>
          <div className="flex shrink-0 items-center gap-1 pt-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
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
          <button
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
            {t("automations.recentRuns")}
          </button>
          
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={busy}>
              <Play className="h-3.5 w-3.5 mr-1.5" /> {t("automations.runNow")}
            </Button>
          </div>
        </div>
        {expanded && (
          <div className="mt-2 flex flex-col gap-2">
            {!runs ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("automations.noRuns")}</p>
            ) : (
              runs.map((run) => (
                <RunItem key={run.id} run={run} automationName={automation.name} />
              ))
            )}
          </div>
        )}
    </Card>
  );
}

function RunItem({ run, automationName }: { run: AutomationRun; automationName: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = React.useState(false);
  const hasResult = !!run.result;

  return (
    <div className="rounded-lg bg-surface-2 p-3">
      <div
        className={cn("flex items-center gap-2", hasResult && "cursor-pointer")}
        onClick={() => hasResult && setExpanded(!expanded)}
      >
        {hasResult && (
           expanded ? <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <RunStatusBadge status={run.status} />
        <div className="ml-auto flex items-center gap-2">
          <time dateTime={run.startedAt} className="text-xs text-muted-foreground">
            {new Date(run.startedAt).toLocaleString(i18n.language)}
          </time>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title={t("home.openInChat")}
            aria-label={t("home.openInChat")}
            onClick={(e) => {
              e.stopPropagation();
              openRunInChat(run.id, () => navigate("/chat"));
            }}
          >
            <MessageSquareShare className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {expanded && hasResult && (
        <DigestView
          content={run.result}
          automationName={automationName}
          runDate={run.startedAt}
          className="mt-2 text-xs"
        />
      )}
    </div>
  );
}
