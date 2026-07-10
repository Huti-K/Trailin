import * as React from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSetupComplete, type AppStatus, type LlmProviderInfo } from "@trailin/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { LinkButton } from "@/components/ui/link-button";
import { Providers } from "@/features/settings/Providers";
import { Accounts } from "@/features/connections/Accounts";
import { toast } from "@/lib/toast";
import { cn, errorMessage } from "@/lib/utils";

/**
 * If the freshly signed-in provider isn't the active one, silently make it
 * active (first model of its catalog) — otherwise the gate never completes
 * for users who pick a provider other than the default. Settings → AI stays
 * the place to change it.
 */
async function ensureActiveModel(providers: LlmProviderInfo[]): Promise<void> {
  try {
    const authed = providers.filter((p) => p.auth !== null);
    if (authed.length === 0) return;
    const settings = await api.modelSettings();
    if (authed.some((p) => p.id === settings.provider)) return;
    for (const p of authed) {
      const [first] = settings.catalog.find((c) => c.id === p.id)?.models ?? [];
      if (first) {
        await api.setModel(p.id, first);
        return;
      }
    }
  } catch {
    // Non-fatal: the model picker in Settings still covers this.
  }
}

/**
 * First-run flow shown instead of the app until the two things the agent
 * can't work without exist: AI credentials and one connected email account.
 */
export function SetupGate({
  status,
  onStatusChanged,
  onFinish,
}: {
  // null while the server can't be reached — the gate stays up and shows an
  // offline notice instead of falling through to the main app.
  status: AppStatus | null;
  onStatusChanged: () => void;
  /** Dismiss the gate; `openSettings` lands on Settings instead of Home. */
  onFinish: (openSettings: boolean) => void;
}) {
  const { t } = useTranslation();
  const [providers, setProviders] = React.useState<LlmProviderInfo[] | null>(null);
  const complete = status !== null && isSetupComplete(status);

  const refreshProviders = React.useCallback(async () => {
    try {
      const list = await api.llmProviders();
      setProviders(list);
      await ensureActiveModel(list);
    } catch (err) {
      toast.error(errorMessage(err));
    }
    onStatusChanged();
  }, [onStatusChanged]);

  React.useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // Sign-in and account linking both finish in other tabs; polling is the
  // only reliable completion signal while the gate is up.
  React.useEffect(() => {
    if (complete) return;
    const timer = setInterval(onStatusChanged, 4000);
    return () => clearInterval(timer);
  }, [complete, onStatusChanged]);

  return (
    <div className="min-h-dvh overflow-y-auto scroll-stable px-5 py-12 sm:px-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-10">
        <div className="flex flex-col gap-3">
          <img src="/logo.svg" alt="" className="h-9 w-fit object-contain" />
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-tight">{t("setup.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("setup.intro")}</p>
          </div>
        </div>

        {status === null ? (
          <div className="tint-warning animate-in-up flex flex-col items-start gap-1.5 rounded-lg p-4">
            <p className="text-sm font-medium">{t("setup.offlineTitle")}</p>
            <p className="text-sm">{t("setup.offlineBody")}</p>
          </div>
        ) : (
          <>
            <Step
              index={1}
              done={status.modelConfigured}
              title={t("setup.stepAiTitle")}
              description={t("setup.stepAiDescription")}
            >
              {status.modelConfigured ? (
                <p className="text-sm font-medium text-success">
                  {t("setup.aiDone", { model: status.model })}
                </p>
              ) : (
                <Providers providers={providers} onChanged={refreshProviders} />
              )}
            </Step>

            <Step
              index={2}
              done={status.emailAccounts > 0}
              title={t("setup.stepEmailTitle")}
              description={t("setup.stepEmailDescription")}
            >
              {status.pipedreamConfigured ? (
                <div className="flex flex-col gap-3">
                  <Accounts onChanged={onStatusChanged} />
                  <LinkButton onClick={() => onFinish(true)}>{t("setup.advancedLink")}</LinkButton>
                </div>
              ) : (
                <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 p-4">
                  <p className="text-sm text-muted-foreground">{t("setup.pipedreamMissingBody")}</p>
                  <Button variant="secondary" size="sm" onClick={() => onFinish(true)}>
                    {t("setup.openSettings")}
                  </Button>
                </div>
              )}
            </Step>
          </>
        )}

        {complete ? (
          <div className="tint-success flex flex-col items-start gap-2 rounded-lg p-4">
            <p className="text-sm font-medium">{t("setup.allSetTitle")}</p>
            <p className="text-sm">{t("setup.allSetBody")}</p>
            <Button className="mt-1" onClick={() => onFinish(false)}>
              {t("setup.openApp")}
            </Button>
          </div>
        ) : (
          <LinkButton onClick={() => onFinish(false)} className="text-sm hover:no-underline">
            {t("setup.skip")}
          </LinkButton>
        )}
      </div>
    </div>
  );
}

function Step({
  index,
  done,
  title,
  description,
  children,
}: {
  index: number;
  done: boolean;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="animate-in-up flex flex-col gap-4"
      style={{ animationDelay: `${(index - 1) * 90}ms` }}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums",
            done ? "tint-success" : "tint-neutral",
          )}
        >
          {done ? <Check className="h-3 w-3" /> : index}
        </span>
        <SectionHeader title={title} description={description} />
      </div>
      <div className="sm:pl-8">{children}</div>
    </section>
  );
}
