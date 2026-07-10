import * as React from "react";
import { Check, ChevronRight, ExternalLink, Loader2, Pencil, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { PipedreamStatus } from "@trailin/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorBanner, LoadingRow } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { ListRow } from "@/components/ui/list-row";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Accounts } from "@/features/connections/Accounts";
import { toast } from "@/lib/toast";
import { cn, errorMessage } from "@/lib/utils";

export function ConnectionsPanel({ onStatusChanged }: { onStatusChanged?: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<PipedreamStatus | null>(null);
  const [editing, setEditing] = React.useState(false);
  // Plumbing is collapsed by default once accounts are connected — the toggle
  // and project credentials matter far less often than the account list.
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // Only for the initial fetch — every error after that is a toast, not a blocking state.
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api.pipedreamStatus());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const afterChange = React.useCallback(async () => {
    setEditing(false);
    await refresh();
    onStatusChanged?.();
  }, [refresh, onStatusChanged]);

  const toggleMode = async (useCustom: boolean) => {
    try {
      setStatus(await api.setPipedreamMode(useCustom));
      onStatusChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!status) {
    return loadError ? (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner>{loadError}</ErrorBanner>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </div>
    ) : (
      <LoadingRow />
    );
  }

  const custom = status.mode === "custom";

  // The custom-project toggle + its wizard/footer row: the only thing that
  // matters during first-time setup, tucked under "Advanced" once an account
  // is connected. Same JSX either way, just relocated by `status.configured`.
  const modeToggle = (
    <ListRow className="animate-in-up py-2.5" style={{ animationDelay: "0ms" }}>
      <div className="min-w-0">
        <Label htmlFor="pd-custom-toggle" className="text-sm font-medium">
          {t("connections.customToggle")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {custom
            ? t("connections.customToggleOn")
            : status.builtinAvailable
              ? t("connections.builtinInUse")
              : t("connections.builtinMissing")}
        </p>
      </div>
      <Switch
        id="pd-custom-toggle"
        checked={custom}
        onCheckedChange={(next) => void toggleMode(next)}
      />
    </ListRow>
  );

  const projectPanel = custom && (
    <div className="animate-in-up" style={{ animationDelay: "25ms" }}>
      {!status.configured || editing ? (
        <SetupWizard
          status={status}
          onSaved={afterChange}
          onClose={status.configured ? () => setEditing(false) : undefined}
        />
      ) : (
        <ListRow className="py-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">
              <Trans
                i18nKey="connections.projectFooter"
                values={{
                  projectId: status.projectId,
                  environment: status.environment,
                  source:
                    status.source === "env"
                      ? t("connections.sourceEnv")
                      : t("connections.sourceSettings"),
                }}
                components={{ code: <span className="font-mono" /> }}
              />
            </p>
          </div>
          <IconButton onClick={() => setEditing(true)} aria-label={t("connections.edit")}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        </ListRow>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {status.configured ? (
        <>
          <div className="animate-in-up" style={{ animationDelay: "0ms" }}>
            <Accounts onChanged={onStatusChanged} />
          </div>
          <div className="animate-in-up" style={{ animationDelay: "50ms" }}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 shrink-0 transition-transform",
                  advancedOpen && "rotate-90",
                )}
              />
              <span>{t("connections.advanced")}</span>
              <span aria-hidden="true">·</span>
              <span>
                {custom ? t("connections.advancedCustom") : t("connections.advancedBuiltin")}
              </span>
            </button>
            {advancedOpen && (
              <div className="mt-3 flex flex-col gap-4">
                {modeToggle}
                {projectPanel}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {modeToggle}
          {projectPanel}
        </>
      )}
    </div>
  );
}

/* ---------------- One-time Pipedream setup ---------------- */

const GUIDE_STEPS = [
  { key: "setupStep1", url: "https://pipedream.com", labelKey: "openPipedream" },
  { key: "setupStep2", url: "https://pipedream.com/settings/api", labelKey: "openApiSettings" },
  { key: "setupStep3", url: "https://pipedream.com/projects", labelKey: "openProjects" },
] as const;

function SetupWizard({
  status,
  onSaved,
  onClose,
}: {
  status: PipedreamStatus;
  onSaved: () => Promise<void>;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [clientId, setClientId] = React.useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = React.useState("");
  const [project, setProject] = React.useState(status.projectId ?? "");
  const [busy, setBusy] = React.useState<"save" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  // A saved-in-app secret can be kept by leaving the field empty.
  const canKeepSecret = status.source === "settings";
  const canSave = Boolean(clientId.trim() && project.trim() && (clientSecret.trim() || canKeepSecret));

  const save = async () => {
    setBusy("save");
    try {
      await api.savePipedream({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        project: project.trim(),
      });
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeSaved = async () => {
    setBusy("remove");
    try {
      await api.clearPipedream();
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  return (
    <Card padding="md" className="animate-in-up flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t("connections.setupTitle")}</p>
          <p className="text-xs text-muted-foreground">
            <Trans
              i18nKey="connections.setupIntro"
              components={{
                pd: (
                  <a
                    href="https://pipedream.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  />
                ),
              }}
            />
          </p>
        </div>
        {onClose && (
          <IconButton onClick={onClose} aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      <ol className="flex flex-col gap-2">
        {GUIDE_STEPS.map((step, i) => (
          <li key={step.key} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="tint-accent flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
                {i + 1}
              </span>
              <p className="text-xs text-muted-foreground">{t(`connections.${step.key}`)}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => window.open(step.url, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink /> {t(`connections.${step.labelKey}`)}
            </Button>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="pd-client-id" label={t("connections.clientId")}>
          <Input
            id="pd-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="font-mono"
            autoComplete="off"
          />
        </FormField>
        <FormField id="pd-client-secret" label={t("connections.clientSecret")}>
          <Input
            id="pd-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={canKeepSecret ? t("connections.clientSecretKeepPlaceholder") : ""}
            className="font-mono"
            autoComplete="off"
          />
        </FormField>
        <FormField id="pd-project" label={t("connections.project")} className="sm:col-span-2">
          <Input
            id="pd-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="https://pipedream.com/@…/projects/proj_…  /  proj_…"
            className="font-mono"
            autoComplete="off"
          />
        </FormField>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        {status.source === "settings" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmRemove(true)}
            disabled={busy !== null}
          >
            {busy === "remove" && <Loader2 className="animate-spin" />}
            {t("connections.removeSaved")}
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} disabled={!canSave || busy !== null}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          {t("connections.saveVerify")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("connections.removeSaved")}
        description={t("connections.removeSavedConfirm")}
        confirmLabel={t("connections.removeSaved")}
        variant="destructive"
        busy={busy === "remove"}
        onConfirm={() => void removeSaved()}
      />
    </Card>
  );
}

