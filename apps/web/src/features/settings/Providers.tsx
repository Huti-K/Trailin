import * as React from "react";
import { ExternalLink, Loader2, Plus, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { LlmProviderInfo, LoginFlowStatus } from "@trailin/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LoadingRow } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/lib/toast";
import { cn, errorMessage } from "@/lib/utils";

/**
 * Provider list + sign-in flows (subscription OAuth or API key).
 * Shared between the first-run setup and the Settings page.
 */
export function Providers({
  providers,
  onChanged,
}: {
  providers: LlmProviderInfo[] | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [flow, setFlow] = React.useState<LoginFlowStatus | null>(null);
  const [adding, setAdding] = React.useState(false);

  // Poll the login flow while one is pending.
  React.useEffect(() => {
    if (!flow || flow.done) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.loginStatus();
        setFlow(next);
        if (next.done) {
          clearInterval(timer);
          await onChanged();
        }
      } catch {
        // transient poll errors are fine
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [flow, onChanged]);

  if (!providers) {
    return <LoadingRow label={t("settings.loadingProviders")} />;
  }

  const startLogin = async (providerId: string) => {
    try {
      setFlow(await api.loginStart(providerId));
    } catch (err) {
      setFlow({ providerId, done: true, error: errorMessage(err) });
    }
  };

  const logout = async (id: string) => {
    try {
      await api.llmLogout(id);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const busy = Boolean(flow && !flow.done);

  // A short, meaningful list: providers you're connected to, plus the subscription
  // sign-ins (Claude, Copilot, ChatGPT) as easy options. The ~30 API-key providers
  // are never listed — they're reached on demand through "Add API key".
  const connected = providers.filter((p) => p.auth !== null);
  const signIns = providers.filter((p) => p.oauth && p.auth === null);
  const rows = [...connected, ...signIns];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map((p, i) => (
          <div key={p.id} className="animate-in-up" style={{ animationDelay: `${i * 50}ms` }}>
            <ProviderRow
              provider={p}
              busy={busy}
              onSignIn={p.oauth && p.auth === null ? () => void startLogin(p.id) : undefined}
              onLogout={() => void logout(p.id)}
            />
          </div>
        ))}
      </div>

      {flow && <LoginFlowCard flow={flow} onClose={() => setFlow(null)} />}

      {adding ? (
        <AddApiKey
          providers={providers}
          onSaved={async () => {
            setAdding(false);
            await onChanged();
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit"
          onClick={() => setAdding(true)}
        >
          <Plus /> {t("settings.addApiKey")}
        </Button>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  busy,
  onSignIn,
  onLogout,
}: {
  provider: LlmProviderInfo;
  busy: boolean;
  onSignIn?: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const connected = provider.auth !== null;
  const canSignOut = provider.auth === "subscription" || provider.auth === "stored_key";
  const status =
    provider.auth === "subscription"
      ? t("settings.providerStatus.subscription")
      : provider.auth === "stored_key"
        ? t("settings.providerStatus.storedKey")
        : provider.auth === "env"
          ? t("settings.providerStatus.env", {
              key: provider.authDetail ?? t("settings.providerStatus.envFallback"),
            })
          : t("settings.providerStatus.none");

  return (
    <ListRow className={cn(connected && "bg-success/10")}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{provider.name}</p>
        <p
          className={cn(
            "truncate text-xs",
            connected ? "font-medium text-success" : "text-muted-foreground",
          )}
        >
          {status} · {t("settings.modelCount", { count: provider.modelCount })}
        </p>
      </div>
      {canSignOut ? (
        <Button variant="ghost" size="sm" onClick={onLogout}>
          {t("common.signOut")}
        </Button>
      ) : onSignIn ? (
        <Button size="sm" onClick={onSignIn} disabled={busy}>
          {t("common.signIn")}
        </Button>
      ) : (
        <span className="shrink-0 text-xs font-medium text-success">env</span>
      )}
    </ListRow>
  );
}

/* ---------------- Add an API-key provider ---------------- */

function AddApiKey({
  providers,
  onSaved,
  onClose,
}: {
  providers: LlmProviderInfo[];
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = React.useState("");

  // Any provider you're not already connected to can take an API key.
  const available = providers.filter((p) => p.auth === null);
  const options = [
    { value: "", label: t("settings.chooseProvider") },
    ...available.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <Card padding="md" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("settings.addApiKeyTitle")}</p>
        <IconButton onClick={onClose} aria-label={t("common.close")}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <Select id="add-key-provider" value={pick} onChange={setPick} options={options} />
      {pick && <ApiKeyEditor providerId={pick} onDone={onSaved} onCancel={() => setPick("")} />}
    </Card>
  );
}

function ApiKeyEditor({
  providerId,
  onDone,
  onCancel,
}: {
  providerId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const done = React.useRef(false);

  // Auto-save when you press Enter or click away — no Save button. The ref guards
  // against Enter + the follow-up blur both firing a save.
  const save = async () => {
    if (done.current || saving || !key.trim()) return;
    done.current = true;
    setSaving(true);
    setError(null);
    try {
      await api.saveApiKey(providerId, key.trim());
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
      done.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          id="api-key-input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
          placeholder={t("settings.apiKeyPlaceholder", { provider: providerId })}
          className="font-mono"
          autoFocus
          disabled={saving}
        />
        {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        <IconButton
          // Cancel on mousedown so it fires before the input's blur-save.
          onMouseDown={(e) => {
            e.preventDefault();
            onCancel();
          }}
          className="rounded-md p-1.5 text-muted-foreground"
          aria-label={t("common.cancel")}
        >
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/* ---------------- Interactive login flow ---------------- */

function LoginFlowCard({ flow, onClose }: { flow: LoginFlowStatus; onClose: () => void }) {
  const { t } = useTranslation();
  const [input, setInput] = React.useState("");

  if (flow.done) {
    return (
      <div
        className={cn(
          "flex items-start justify-between gap-3 rounded-lg p-3.5 text-sm",
          flow.error ? "tint-danger" : "tint-success",
        )}
      >
        <p>
          {flow.error ??
            t("settings.signedInWith", { provider: flow.providerName ?? flow.providerId })}
        </p>
        <IconButton onClick={onClose} aria-label={t("common.dismiss")}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-accent/10 p-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {t("settings.signingInWith", { provider: flow.providerName ?? flow.providerId })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await api.loginCancel();
            } catch {
              // Flow may already be gone server-side — still dismiss the card.
            } finally {
              onClose();
            }
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>

      {flow.select && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{flow.select.message}</p>
          <div className="flex flex-wrap gap-2">
            {flow.select.options.map((option) => (
              <Button
                key={option.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  void api.loginSelect(option.id).catch((err) => toast.error(errorMessage(err)));
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {flow.authUrl && (
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            className="w-fit"
            onClick={() => window.open(flow.authUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink /> {t("settings.openSignInPage")}
          </Button>
          {flow.instructions && (
            <p className="text-xs text-muted-foreground">{flow.instructions}</p>
          )}
        </div>
      )}

      {flow.deviceCode && (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-xs text-muted-foreground">
            <Trans
              i18nKey="settings.enterCodeAt"
              values={{ uri: flow.deviceCode.verificationUri }}
              components={{
                uri: (
                  <a
                    href={flow.deviceCode.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  />
                ),
              }}
            />
          </p>
          <p className="font-mono text-lg font-semibold tracking-widest">
            {flow.deviceCode.userCode}
          </p>
        </div>
      )}

      {(flow.prompt || flow.authUrl) && (
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={flow.prompt?.placeholder ?? t("settings.loginInputPlaceholder")}
            className="font-mono text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!input.trim()}
            onClick={async () => {
              try {
                await api.loginInput(input.trim());
                setInput("");
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            {t("common.submit")}
          </Button>
        </div>
      )}
      {flow.prompt && <p className="text-xs text-muted-foreground">{flow.prompt.message}</p>}
    </div>
  );
}
