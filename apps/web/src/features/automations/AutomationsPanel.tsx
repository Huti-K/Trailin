import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, AutomationSuggestion } from "@trailin/shared";
import { CalendarClock, Plus, Sparkles } from "lucide-react";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkButton } from "@/components/ui/link-button";
import { Select } from "@/components/ui/select";
import { SettingRow } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AutomationCard } from "@/features/automations/AutomationCard";
import {
  buildCron,
  DEFAULT_PRESET,
  daysInMonth,
  monthName,
  parseCron,
  type SchedulePreset,
  scheduleLabel,
  weekdayName,
  weekdayShortName,
} from "@/features/automations/schedule";
import { api } from "@/lib/api";
import { desktopBridge } from "@/lib/desktop";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

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
  const queryClient = useQueryClient();
  // Server-side changes (agent tools, scheduled runs, the suggestion sweep)
  // land via "automations" topic invalidation; refetches keep previous data,
  // so the cards never unmount and drop their state.
  const automationsQuery = useQuery({
    queryKey: ["automations", "list"],
    queryFn: () => api.automations(),
  });
  const suggestionsQuery = useQuery({
    queryKey: ["automations", "suggestions"],
    queryFn: () => api.automationSuggestions(),
  });
  const automations = automationsQuery.data ?? [];
  const suggestions = suggestionsQuery.data ?? [];
  const loading = automationsQuery.isPending || suggestionsQuery.isPending;
  const loadError = automationsQuery.error ?? suggestionsQuery.error;
  React.useEffect(() => {
    if (loadError) toast.error(loadError);
  }, [loadError]);
  const refreshAutomations = () => queryClient.invalidateQueries({ queryKey: ["automations"] });
  const [showForm, setShowForm] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    instruction: "",
    showInActivity: true,
    runOnNewMail: false,
    notifyOnCompletion: false,
  });
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

  const resetForm = () => {
    setForm({
      name: "",
      instruction: "",
      showInActivity: true,
      runOnNewMail: false,
      notifyOnCompletion: false,
    });
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
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
    } catch (err) {
      toast.error(err);
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
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const openForEdit = (automation: Automation) => {
    setForm({
      name: automation.name,
      instruction: automation.instruction,
      showInActivity: automation.showInActivity,
      runOnNewMail: automation.runOnNewMail,
      notifyOnCompletion: automation.notifyOnCompletion,
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
                variant="ghost-danger"
                className="text-destructive"
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
                disabled={!form.name.trim() || !form.instruction.trim() || !scheduleValid}
                loading={saving}
              >
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
                className={cn("font-mono tabular", !cronValid && cron.trim() && "text-destructive")}
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
                      { value: "manual", label: t("automations.frequency.manual") },
                    ]}
                  />
                </div>
                {preset.frequency !== "manual" && (
                  <Input
                    type="time"
                    value={preset.time}
                    onChange={(e) => setPreset({ ...preset, time: e.target.value || "08:00" })}
                    className="w-28 tabular-nums"
                    aria-label={t("automations.time")}
                  />
                )}
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
          {!advanced && preset.frequency === "manual" && (
            <p className="text-xs text-muted-foreground">{t("automations.manualHint")}</p>
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

        <SettingRow
          bare
          htmlFor="automation-activity"
          label={t("automations.showInActivity")}
          description={t("automations.showInActivityHint")}
        >
          <Switch
            id="automation-activity"
            checked={form.showInActivity}
            onCheckedChange={(v) => setForm({ ...form, showInActivity: v })}
            aria-label={t("automations.showInActivity")}
          />
        </SettingRow>

        <SettingRow
          bare
          htmlFor="automation-run-on-new-mail"
          label={t("automations.runOnNewMail")}
          description={t("automations.runOnNewMailHint")}
        >
          <Switch
            id="automation-run-on-new-mail"
            checked={form.runOnNewMail}
            onCheckedChange={(v) => setForm({ ...form, runOnNewMail: v })}
            aria-label={t("automations.runOnNewMail")}
          />
        </SettingRow>

        <SettingRow
          bare
          htmlFor="automation-notify"
          label={t("automations.notifyOnCompletion")}
          description={t("automations.notifyOnCompletionHint")}
        >
          <Switch
            id="automation-notify"
            checked={form.notifyOnCompletion}
            onCheckedChange={(v) => {
              setForm({ ...form, notifyOnCompletion: v });
              // Browser tabs need a Notification grant, and requesting one is
              // only allowed on a user gesture — this toggle is that gesture.
              // The desktop shell notifies from its main process, no grant.
              if (
                v &&
                !desktopBridge() &&
                "Notification" in window &&
                Notification.permission === "default"
              ) {
                void Notification.requestPermission();
              }
            }}
            aria-label={t("automations.notifyOnCompletion")}
          />
        </SettingRow>
      </Dialog>

      {suggestions.length > 0 && (
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {t("automations.suggestions.title")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("automations.suggestions.hint")}
            </p>
          </div>
          {suggestions.map((suggestion, i) => (
            <div
              key={suggestion.id}
              className="animate-in-up"
              style={{ animationDelay: `${i * 45}ms` }}
            >
              <SuggestionCard suggestion={suggestion} onDecided={refreshAutomations} />
            </div>
          ))}
        </div>
      )}

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
              style={{ animationDelay: `${i * 45}ms` }}
            >
              <AutomationCard
                automation={automation}
                onChanged={refreshAutomations}
                onEdit={() => openForEdit(automation)}
              />
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
        busy={saving}
        onConfirm={() => void remove()}
      />
    </div>
  );
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
      value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b),
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

/** One pending proposal from the suggestion sweep: rationale up front, instruction behind a disclosure, accept/dismiss to decide. */
function SuggestionCard({
  suggestion,
  onDecided,
}: {
  suggestion: AutomationSuggestion;
  onDecided: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const [showInstruction, setShowInstruction] = React.useState(false);

  const label = scheduleLabel(suggestion.schedule, t, i18n.language);

  const decide = async (action: "accept" | "dismiss") => {
    setBusy(true);
    try {
      if (action === "accept") await api.acceptAutomationSuggestion(suggestion.id);
      else await api.dismissAutomationSuggestion(suggestion.id);
      await onDecided();
    } catch (err) {
      toast.error(err);
      // Only on failure — on success the refetch removes this card entirely.
      setBusy(false);
    }
  };

  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight">
        {suggestion.name}
        <Badge
          variant="muted"
          className={cn("text-2xs", !label && "font-mono")}
          title={suggestion.schedule}
        >
          {label ?? suggestion.schedule}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{suggestion.rationale}</p>
      <div className="mt-2">
        <DisclosureToggle open={showInstruction} onToggle={() => setShowInstruction((v) => !v)}>
          {t("automations.suggestions.showInstruction")}
        </DisclosureToggle>
        {showInstruction && (
          <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs text-muted-foreground">
            {suggestion.instruction}
          </p>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void decide("dismiss")} disabled={busy}>
          {t("automations.suggestions.dismiss")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void decide("accept")} loading={busy}>
          {t("automations.suggestions.accept")}
        </Button>
      </div>
    </Card>
  );
}
