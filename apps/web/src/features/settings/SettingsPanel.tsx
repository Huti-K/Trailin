import {
  type AppStatus,
  isLanguage,
  LANGUAGE_LABELS,
  type LlmProviderInfo,
  type ModelSettings,
  SUPPORTED_LANGUAGES,
} from "@trailin/shared";
import {
  Check,
  DatabaseBackup,
  Download,
  Loader2,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorBanner, LoadingRow } from "@/components/ui/feedback";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/list-row";
import { Section } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import { ConnectionsPanel } from "@/features/connections/ConnectionsPanel";
import { Providers } from "@/features/settings/Providers";
import { WriteAccess } from "@/features/settings/WriteAccess";
import { api } from "@/lib/api";
import { rememberLanguage } from "@/lib/i18n";
import { type QuickActionMode, useQuickActionMode } from "@/lib/quickActions";
import { toast } from "@/lib/toast";
import { type ThemePref, useTheme } from "@/lib/useTheme";
import { errorMessage } from "@/lib/utils";

export function SettingsPanel({ onStatusChanged }: { onStatusChanged?: () => void }) {
  const { t } = useTranslation();
  const [providers, setProviders] = React.useState<LlmProviderInfo[] | null>(null);
  const [armedCount, setArmedCount] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<AppStatus | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [nextProviders, nextStatus] = await Promise.all([api.llmProviders(), api.status()]);
      setProviders(nextProviders);
      setStatus(nextStatus);
      onStatusChanged?.();
    } catch (err) {
      toast.error(err);
    }
  }, [onStatusChanged]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectedIds = React.useMemo(
    () => providers?.filter((p) => p.auth !== null).map((p) => p.id) ?? [],
    [providers],
  );

  // Transient outages (Pipedream configured but the account count came back
  // unknown) show no chip at all — it's not a setup problem worth flagging.
  const emailChip = (() => {
    if (!status) return null;
    if (!status.pipedreamConfigured) {
      return (
        <StatusChip tone="warning" icon={<TriangleAlert />}>
          {t("settings.sections.email.chipSetup")}
        </StatusChip>
      );
    }
    if (!status.emailAccountsKnown) return null;
    if (status.emailAccounts > 0) {
      return (
        <StatusChip tone="success" icon={<Check />}>
          {t("settings.sections.email.chipConnected", { count: status.emailAccounts })}
        </StatusChip>
      );
    }
    return <StatusChip tone="muted">{t("settings.sections.email.chipNoAccounts")}</StatusChip>;
  })();

  return (
    <div className="flex flex-col gap-10 pt-4">
      <Section
        index={0}
        className="animate-in-up"
        icon={<Sparkles />}
        title={t("settings.sections.ai.title")}
        description={t("settings.sections.ai.description")}
        aside={
          status &&
          (status.modelConfigured ? (
            <StatusChip tone="success" icon={<Check />}>
              {t("settings.sections.ai.chipReady")}
            </StatusChip>
          ) : (
            <StatusChip tone="warning" icon={<TriangleAlert />}>
              {t("settings.sections.ai.chipSignIn")}
            </StatusChip>
          ))
        }
      >
        <div className="flex flex-col gap-5">
          <Providers providers={providers} onChanged={refresh} />
          <ModelPicker connectedIds={connectedIds} onSaved={refresh} />
        </div>
      </Section>

      <Section
        index={1}
        className="animate-in-up"
        icon={<Mail />}
        title={t("settings.sections.email.title")}
        description={t("settings.sections.email.description")}
        aside={emailChip}
      >
        <ConnectionsPanel onStatusChanged={() => void refresh()} />
      </Section>

      <Section
        index={2}
        className="animate-in-up"
        icon={<ShieldCheck />}
        title={t("settings.sections.permissions.title")}
        description={t("settings.sections.permissions.description")}
        aside={
          armedCount !== null &&
          (armedCount > 0 ? (
            <StatusChip tone="warning" icon={<TriangleAlert />}>
              {t("settings.permissions.chipOn", { count: armedCount })}
            </StatusChip>
          ) : (
            <StatusChip tone="success" icon={<ShieldCheck />}>
              {t("settings.permissions.chipOff")}
            </StatusChip>
          ))
        }
      >
        <WriteAccess onState={setArmedCount} />
      </Section>

      <Section
        index={3}
        className="animate-in-up"
        icon={<SlidersHorizontal />}
        title={t("settings.sections.preferences.title")}
        description={t("settings.sections.preferences.description")}
      >
        <div className="flex flex-col gap-2">
          <AppearanceRow />
          <LanguageRow />
          <TimezoneRow />
          <QuickActionsRow />
          <SyncBackfillRow />
          <ContactThreadsRow />
        </div>
      </Section>

      <Section
        index={4}
        className="animate-in-up"
        icon={<DatabaseBackup />}
        title={t("settings.sections.data.title")}
        description={t("settings.sections.data.description")}
      >
        <BackupRow />
      </Section>
    </div>
  );
}

/* ---------------- Local data ---------------- */

/** Local database snapshot — everything except connection credentials, which live outside the DB. */
function BackupRow() {
  const { t } = useTranslation();
  return (
    <ListRow>
      <div className="min-w-0">
        <Label className="text-sm font-medium">{t("settings.backup.label")}</Label>
        <p className="text-xs text-muted-foreground">{t("settings.backup.description")}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={() => api.downloadBackup()}
      >
        <Download />
        {t("settings.backup.cta")}
      </Button>
    </ListRow>
  );
}

/* ---------------- Preferences ---------------- */

/** Shared row shape for every preference: label + description at left, a Select at right. */
function PreferenceRow({
  id,
  label,
  description,
  error,
  saving,
  value,
  onChange,
  options,
  searchable,
}: {
  id: string;
  label: string;
  description: React.ReactNode;
  error?: string | null;
  saving?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  searchable?: boolean;
}) {
  return (
    <ListRow>
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Select
          id={id}
          aria-label={label}
          className="w-40 sm:w-52"
          value={value}
          onChange={onChange}
          options={options}
          searchable={searchable}
        />
      </div>
    </ListRow>
  );
}

function AppearanceRow() {
  const { t } = useTranslation();
  const [pref, , setPref] = useTheme();

  return (
    <PreferenceRow
      id="settings-appearance"
      label={t("settings.appearance.label")}
      description={t("settings.appearance.description")}
      value={pref}
      onChange={(value) => setPref(value as ThemePref)}
      options={[
        { value: "light", label: t("settings.appearance.light") },
        { value: "dark", label: t("settings.appearance.dark") },
        { value: "system", label: t("settings.appearance.system") },
      ]}
    />
  );
}

function LanguageRow() {
  const { t, i18n } = useTranslation();
  const [state, setState] = React.useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  // Auto-save like the model picker: persist on change, no Save button. The
  // server resets agent sessions so the assistant answers in the new language.
  const persist = async (value: string) => {
    if (!isLanguage(value) || value === i18n.language) return;
    setState("saving");
    setError(null);
    try {
      const { language } = await api.setLanguage(value);
      await i18n.changeLanguage(language);
      rememberLanguage(language);
      setState("idle");
    } catch (err) {
      setState("error");
      setError(errorMessage(err));
    }
  };

  return (
    <PreferenceRow
      id="settings-language"
      label={t("settings.sections.language.title")}
      description={t("settings.sections.language.description")}
      error={state === "error" ? error : null}
      saving={state === "saving"}
      value={i18n.language}
      onChange={(value) => void persist(value)}
      options={SUPPORTED_LANGUAGES.map((code) => ({
        value: code,
        label: LANGUAGE_LABELS[code],
      }))}
      searchable
    />
  );
}

function timezoneOffset(tz: string): string {
  try {
    return (
      new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

// Computing an offset per zone (~430 Intl.DateTimeFormat constructions) is too
// costly for app startup, so the list is built lazily on first Settings render
// and cached for the session.
let timezoneOptionsCache: { value: string; label: string }[] | null = null;

function getTimezoneOptions(): { value: string; label: string }[] {
  if (timezoneOptionsCache) return timezoneOptionsCache;
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [Intl.DateTimeFormat().resolvedOptions().timeZone];
  }
  timezoneOptionsCache = zones.map((tz) => {
    const name = tz.replace(/_/g, " ");
    const offset = timezoneOffset(tz);
    return { value: tz, label: offset ? `${name} (${offset})` : name };
  });
  return timezoneOptionsCache;
}

function TimezoneRow() {
  const { t, i18n } = useTranslation();
  const options = React.useMemo(getTimezoneOptions, []);
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .timezone()
      .then((r) => setTimezone(r.timezone))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  // Fall back to the browser's zone for display until the server answers.
  const fallback = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const value = timezone ?? fallback;

  const persist = async (next: string) => {
    if (next === value) return;
    setState("saving");
    setError(null);
    try {
      // The server resets agent sessions itself so schedules re-anchor to the new zone.
      const { timezone: saved } = await api.setTimezone(next);
      setTimezone(saved);
      setState("idle");
    } catch (err) {
      setState("error");
      setError(errorMessage(err));
    }
  };

  let localTime = "";
  try {
    localTime = new Intl.DateTimeFormat(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: value,
    }).format(new Date());
  } catch {
    // leave blank if the runtime can't resolve this zone
  }

  const description = localTime
    ? `${t("settings.timezone.description")} · ${t("settings.timezone.localTime", { time: localTime })}`
    : t("settings.timezone.description");

  return (
    <PreferenceRow
      id="settings-timezone"
      label={t("settings.timezone.label")}
      description={description}
      error={state === "error" ? error : null}
      saving={state === "saving"}
      value={value}
      onChange={(next) => void persist(next)}
      options={options}
      searchable
    />
  );
}

/**
 * A numeric preference persisted on the server: loads the current value on
 * mount and saves on change like every other preference row. A current value
 * outside the preset choices (e.g. seeded through an env override) is kept as
 * an extra option so the Select always shows the real setting.
 */
function ServerNumberRow({
  id,
  label,
  description,
  choices,
  fallback,
  load,
  save,
  format,
}: {
  id: string;
  label: string;
  description: string;
  choices: number[];
  fallback: number;
  load: () => Promise<number>;
  save: (value: number) => Promise<number>;
  format: (value: number) => string;
}) {
  const [value, setValue] = React.useState<number | null>(null);
  const [state, setState] = React.useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    load()
      .then(setValue)
      .catch((err) => setError(errorMessage(err)));
  }, [load]);

  // Show the server default until the fetch answers, like TimezoneRow's fallback.
  const current = value ?? fallback;

  const persist = async (next: number) => {
    if (!Number.isInteger(next) || next === current) return;
    setState("saving");
    setError(null);
    try {
      setValue(await save(next));
      setState("idle");
    } catch (err) {
      setState("error");
      setError(errorMessage(err));
    }
  };

  const values = choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);

  return (
    <PreferenceRow
      id={id}
      label={label}
      description={description}
      error={error}
      saving={state === "saving"}
      value={String(current)}
      onChange={(next) => void persist(Number(next))}
      options={values.map((n) => ({ value: String(n), label: format(n) }))}
    />
  );
}

const BACKFILL_DAY_CHOICES = [7, 14, 30, 60, 90, 180, 365];
const loadBackfillDays = () => api.syncBackfillDays().then((r) => r.days);
const saveBackfillDays = (days: number) => api.setSyncBackfillDays(days).then((r) => r.days);

function SyncBackfillRow() {
  const { t } = useTranslation();
  return (
    <ServerNumberRow
      id="settings-sync-backfill"
      label={t("settings.syncBackfill.label")}
      description={t("settings.syncBackfill.description")}
      choices={BACKFILL_DAY_CHOICES}
      fallback={30}
      load={loadBackfillDays}
      save={saveBackfillDays}
      format={(days) => t("settings.syncBackfill.option", { count: days })}
    />
  );
}

const CONTACT_THREAD_CHOICES = [5, 10, 15, 25, 50];
const loadContactThreads = () => api.contactThreadsLimit().then((r) => r.limit);
const saveContactThreads = (limit: number) =>
  api.setContactThreadsLimit(limit).then((r) => r.limit);

function ContactThreadsRow() {
  const { t } = useTranslation();
  return (
    <ServerNumberRow
      id="settings-contact-threads"
      label={t("settings.contactThreads.label")}
      description={t("settings.contactThreads.description")}
      choices={CONTACT_THREAD_CHOICES}
      fallback={15}
      load={loadContactThreads}
      save={saveContactThreads}
      format={(limit) => t("settings.contactThreads.option", { count: limit })}
    />
  );
}

function QuickActionsRow() {
  const { t } = useTranslation();
  const [mode, setMode] = useQuickActionMode();

  return (
    <PreferenceRow
      id="settings-quick-actions"
      label={t("settings.sections.quickActions.title")}
      description={t("settings.sections.quickActions.description")}
      value={mode}
      onChange={(value) => setMode(value as QuickActionMode)}
      options={[
        { value: "send", label: t("settings.sections.quickActions.send") },
        { value: "prefill", label: t("settings.sections.quickActions.prefill") },
      ]}
    />
  );
}

/* ---------------- Model picker ---------------- */

function ModelPicker({
  connectedIds,
  onSaved,
}: {
  connectedIds: string[];
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = React.useState<ModelSettings | null>(null);
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [state, setState] = React.useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .modelSettings()
      .then((s) => {
        setSettings(s);
        setProvider(s.provider);
        setModel(s.model);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  if (!settings) {
    return error ? <ErrorBanner>{error}</ErrorBanner> : <LoadingRow />;
  }

  // Only offer models from providers you're connected to (but always keep the
  // active provider selectable so the current value stays valid).
  const connectedSet = new Set(connectedIds);
  const usable = settings.catalog.filter(
    (c) => c.models.length > 0 && (connectedSet.has(c.id) || c.id === settings.provider),
  );

  if (connectedIds.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("settings.signInFirst")}</p>;
  }

  const activeCatalog = usable.find((c) => c.id === provider);

  // Auto-save: persist as soon as the provider or model changes — no Save button.
  const persist = async (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModel(nextModel);
    if (!nextModel) return;
    setState("saving");
    setError(null);
    try {
      const next = await api.setModel(nextProvider, nextModel);
      setSettings(next);
      setState("idle");
      await onSaved();
    } catch (err) {
      setState("error");
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-provider">{t("settings.provider")}</Label>
          <Select
            id="settings-provider"
            value={provider}
            onChange={(value) =>
              void persist(value, usable.find((c) => c.id === value)?.models[0] ?? "")
            }
            options={usable.map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-model">{t("settings.model")}</Label>
          <Select
            id="settings-model"
            value={model}
            onChange={(value) => void persist(provider, value)}
            options={(activeCatalog?.models ?? []).map((m) => ({ value: m, label: m }))}
            searchable
          />
        </div>
      </div>
      <div className="flex h-4 items-center justify-end gap-1.5 text-xs text-muted-foreground">
        {state === "saving" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common.saving")}
          </>
        ) : state === "error" ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <>
            <Check className="h-3.5 w-3.5 text-success" />
            <span>
              <Trans
                i18nKey="settings.usingModel"
                values={{ model: settings.model }}
                components={{ model: <span className="font-mono" /> }}
              />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
