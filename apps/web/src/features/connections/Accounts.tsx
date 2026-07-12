import {
  type AccountColor,
  type AccountDescription,
  type AccountVoice,
  type ConnectedAccount,
  EMAIL_APP_LABELS,
  EMAIL_APPS,
  type EmailApp,
  type PipedreamApp,
} from "@trailin/shared";
import { Inbox, Loader2, Mail, Pencil, PenLine, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorPicker } from "@/components/ui/color-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SignatureEditor } from "@/features/connections/SignatureEditor";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, UNASSIGNED_ACCOUNT_COLOR } from "@/lib/utils";

/** App logo from Pipedream, falling back to a generic mail glyph. */
function AppIcon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={cn("h-4 w-4 shrink-0 object-contain", className)}
      />
    );
  }
  return <Mail className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} />;
}

/** One selectable app in the picker — a grey listbox row. */
function PickerRow({
  app,
  busy,
  onConnect,
}: {
  app: PipedreamApp;
  busy: string | null;
  onConnect: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onConnect(app.slug)}
      disabled={busy !== null}
      className="group flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5 text-left transition hover:brightness-95 disabled:opacity-50 dark:hover:brightness-110"
    >
      <AppIcon src={app.imgSrc} className="h-5 w-5" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{app.name}</span>
      {busy === app.slug ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Plus className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

/** A labelled group of picker rows (e.g. "Popular email apps"). */
function PickerSection({
  heading,
  apps,
  busy,
  onConnect,
}: {
  heading: string;
  apps: PipedreamApp[];
  busy: string | null;
  onConnect: (slug: string) => void;
}) {
  if (apps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </p>
      {apps.map((app) => (
        <PickerRow key={app.slug} app={app} busy={busy} onConnect={onConnect} />
      ))}
    </div>
  );
}

function appLabel(account: ConnectedAccount): string {
  if (account.appName) return account.appName;
  const known = EMAIL_APP_LABELS[account.app as EmailApp];
  if (known) return known;
  return account.app
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Generates a nice vibrant pastel tone by varying the hue. */
function generateTonalHex(index: number): string {
  // Golden angle approximation (137.5) distributes hues nicely around the 360 wheel
  const hue = (index * 137.5) % 360;
  // HSL: 70% saturation, 65% lightness
  const s = 0.7;
  const l = 0.65;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Connected accounts (any app, several per app) + the Connect-Link picker.
 * Shared between the first-run setup and Settings → Email.
 */
export function Accounts({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = React.useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PipedreamApp[] | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [colors, setColors] = React.useState<AccountColor[]>([]);
  const [descriptions, setDescriptions] = React.useState<AccountDescription[]>([]);
  const [voices, setVoices] = React.useState<AccountVoice[]>([]);
  const [signatureAccountId, setSignatureAccountId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [noteDraft, setNoteDraft] = React.useState("");
  const noteHandled = React.useRef(false);

  // Debounced catalog search; empty query shows the e-mail suggestions.
  React.useEffect(() => {
    if (!pickerOpen) return;
    const q = query.trim();
    setResults(null);
    const timer = setTimeout(
      () => {
        api
          .pipedreamApps(q)
          .then(setResults)
          .catch((err) => {
            toast.error(err);
            setResults([]);
          });
      },
      q ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [query, pickerOpen]);

  const load = React.useCallback(async (): Promise<ConnectedAccount[] | null> => {
    try {
      const next = await api.pipedreamAccounts();
      setAccounts(next);
      return next;
    } catch (err) {
      toast.error(err);
      return null;
    }
  }, []);

  const loadColors = React.useCallback(async () => {
    try {
      const { colors: saved } = await api.accountColors();
      setColors(saved);
      return saved;
    } catch {
      return [] as AccountColor[];
    }
  }, []);

  const loadDescriptions = React.useCallback(async () => {
    try {
      const { descriptions: saved } = await api.accountDescriptions();
      setDescriptions(saved);
      return saved;
    } catch {
      return [] as AccountDescription[];
    }
  }, []);

  // Auto-assign nice tonal colors for accounts that don't have one yet.
  const ensureColors = React.useCallback(
    async (accts: ConnectedAccount[], existing: AccountColor[]) => {
      const missing = accts.filter((a) => !existing.some((c) => c.accountId === a.id));
      if (missing.length === 0) return;

      let idx = existing.length;

      const additions: AccountColor[] = missing.map((a) => {
        const hex = generateTonalHex(idx);
        idx++;
        return { accountId: a.id, hex };
      });

      const merged = [...existing, ...additions];
      setColors(merged);
      try {
        await api.setAccountColors(merged);
      } catch {
        // best-effort persist
      }
    },
    [],
  );

  const loadVoices = React.useCallback(async () => {
    try {
      const { voices: saved } = await api.accountVoices();
      setVoices(saved);
    } catch {
      /* signatures remain optional */
    }
  }, []);

  React.useEffect(() => {
    void loadVoices();
    void Promise.all([load(), loadColors(), loadDescriptions()]).then(([accts, saved]) => {
      if (accts && saved) void ensureColors(accts, saved);
    });
  }, [load, loadColors, loadDescriptions, loadVoices, ensureColors]);

  const connect = async (app: string) => {
    setBusy(app);
    try {
      // Lazy-loaded: the Connect SDK is only needed when linking an account,
      // so it stays out of the initial bundle.
      const { createFrontendClient } = await import("@pipedream/sdk/browser");
      const token = await api.pipedreamConnectToken(app);
      const pd = createFrontendClient({
        externalUserId: token.externalUserId,
        tokenCallback: async () => ({
          token: token.token,
          connectLinkUrl: token.connectLinkUrl,
          expiresAt: new Date(token.expiresAt),
        }),
      });
      setPickerOpen(false);
      setQuery("");
      setConnecting(true);
      await pd.connectAccount({
        app,
        token: token.token,
        onSuccess: () => {
          setConnecting(false);
          // The new account has no color yet — assign one against the latest
          // saved colors rather than waiting for a remount to pick it up.
          void load().then((next) => {
            if (next) void loadColors().then((saved) => ensureColors(next, saved));
            onChanged?.();
          });
        },
        onError: (err) => {
          setConnecting(false);
          toast.error(err.message);
        },
        onClose: () => setConnecting(false),
      });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setRemoving(true);
    try {
      await api.deletePipedreamAccount(id);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setRemoving(false);
      setConfirmId(null);
    }
  };

  // react-colorful fires onChange on every pointer-move tick while dragging, and
  // the hex input fires on every keystroke — persisting each one issues dozens of
  // concurrent POSTs whose responses can land out of order. Debounce the persist
  // (the swatch itself still updates immediately via setColors below) and replay
  // it once more if a newer color arrived while a write was in flight, so the
  // last color the user picked is always the one that ends up saved.
  const colorPersistRef = React.useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    saving: boolean;
    pending: AccountColor[] | null;
  }>({ timer: null, saving: false, pending: null });

  const flushColorPersist = async () => {
    const state = colorPersistRef.current;
    if (state.saving || !state.pending) return;
    const next = state.pending;
    state.pending = null;
    state.saving = true;
    try {
      await api.setAccountColors(next);
    } catch (err) {
      toast.error(err);
    } finally {
      state.saving = false;
      if (state.pending) void flushColorPersist();
    }
  };

  const updateColor = (accountId: string, hex: string) => {
    const next = colors.filter((c) => c.accountId !== accountId);
    next.push({ accountId, hex });
    setColors(next);

    const state = colorPersistRef.current;
    state.pending = next;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void flushColorPersist();
    }, 300);
  };

  const colorFor = (accountId: string): AccountColor | undefined =>
    colors.find((c) => c.accountId === accountId);

  const noteFor = (accountId: string) =>
    descriptions.find((d) => d.accountId === accountId)?.text ?? "";

  const startEditingNote = (accountId: string) => {
    // Enter/Escape set this true and unmount the input without firing blur
    // (browsers don't dispatch focusout for a removed element), so a stale
    // true would swallow the next edit's blur-commit. Clear it up front.
    noteHandled.current = false;
    setNoteDraft(noteFor(accountId));
    setEditingId(accountId);
  };

  const commitNote = async (accountId: string) => {
    setEditingId(null);
    const text = noteDraft.trim();
    const next = descriptions.filter((d) => d.accountId !== accountId);
    if (text) next.push({ accountId, text });
    setDescriptions(next);
    try {
      await api.setAccountDescriptions(next);
    } catch (err) {
      toast.error(err);
    }
  };

  // Split the pre-search suggestions into "email apps" and "everything else",
  // so the picker shows email providers plus a taste of the wider catalog.
  const isEmailApp = (slug: string) => (EMAIL_APPS as readonly string[]).includes(slug);
  const emailResults = (results ?? []).filter((a) => isEmailApp(a.slug));
  const moreResults = (results ?? []).filter((a) => !isEmailApp(a.slug));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4 pb-2">
          <h3 className="text-sm font-semibold tracking-tight">{t("connections.emailAccounts")}</h3>
          <Button size="sm" onClick={() => setPickerOpen((open) => !open)} disabled={busy !== null}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            {t("connections.addAccount")}
          </Button>
        </div>

        {pickerOpen && (
          <Card padding="sm" className="flex flex-col gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("connections.searchProviders")}
              autoFocus
            />
            {!results ? (
              <div className="flex flex-col gap-1.5 py-0.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-11 w-full rounded-lg" />
                ))}
              </div>
            ) : results.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {t("connections.noProvidersFound", { q: query.trim() })}
              </p>
            ) : query.trim() ? (
              <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto py-0.5">
                {results.map((app) => (
                  <PickerRow key={app.slug} app={app} busy={busy} onConnect={connect} />
                ))}
              </div>
            ) : (
              <div className="flex max-h-80 flex-col gap-4 overflow-y-auto py-0.5">
                <PickerSection
                  heading={t("connections.suggestedHeading")}
                  apps={emailResults}
                  busy={busy}
                  onConnect={connect}
                />
                {moreResults.length > 0 && (
                  <PickerSection
                    heading={t("connections.moreAppsHeading")}
                    apps={moreResults}
                    busy={busy}
                    onConnect={connect}
                  />
                )}
              </div>
            )}
            <p className="px-1 pt-0.5 text-2xs leading-relaxed text-muted-foreground">
              {t("connections.anyAppHint")}
            </p>
          </Card>
        )}

        {connecting && (
          <p className="text-xs text-muted-foreground">{t("connections.finishConnecting")}</p>
        )}

        {!accounts ? (
          <div className="flex flex-col gap-2">
            {[0, 1].map((i) => (
              <ListRow key={i}>
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </ListRow>
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState icon={Inbox} description={t("connections.noAccounts")} />
        ) : (
          <div className="flex flex-col gap-2">
            {accounts.map((account, i) => (
              <div
                key={account.id}
                className="animate-in-up flex flex-col gap-1.5"
                style={{ animationDelay: `${i * 45}ms`, zIndex: accounts.length - i }}
              >
                <ListRow className="relative">
                  <div className="flex min-w-0 items-center gap-3">
                    <ColorPicker
                      color={colorFor(account.id)?.hex ?? UNASSIGNED_ACCOUNT_COLOR}
                      onSelect={(hex) => updateColor(account.id, hex)}
                    />
                    <AppIcon src={account.imgSrc} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{account.name}</p>
                      <p className="text-xs text-muted-foreground">{appLabel(account)}</p>
                      {editingId === account.id ? (
                        <Input
                          autoFocus
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              noteHandled.current = true;
                              void commitNote(account.id);
                            } else if (e.key === "Escape") {
                              noteHandled.current = true;
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => {
                            if (noteHandled.current) {
                              noteHandled.current = false;
                              return;
                            }
                            void commitNote(account.id);
                          }}
                          placeholder={t("connections.notePlaceholder")}
                          className="mt-0.5 h-6 w-full min-w-0 px-1.5 py-0 text-xs"
                        />
                      ) : (
                        noteFor(account.id) && (
                          <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                            {noteFor(account.id)}
                          </p>
                        )
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={account.healthy ? "success" : "destructive"}>
                      {account.healthy ? t("connections.healthy") : t("connections.unhealthy")}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => startEditingNote(account.id)}
                      title={t("connections.editNote")}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setSignatureAccountId((id) => (id === account.id ? null : account.id))
                      }
                      title="Edit email signature"
                    >
                      <PenLine className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmId(account.id)}
                      title={t("connections.disconnect")}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </ListRow>
                {signatureAccountId === account.id && (
                  <SignatureEditor
                    voice={voices.find((voice) => voice.accountId === account.id)}
                    onCancel={() => setSignatureAccountId(null)}
                    onSave={async (signature, signatureHtml) => {
                      const existing = voices.find((voice) => voice.accountId === account.id);
                      const next = [
                        ...voices.filter((voice) => voice.accountId !== account.id),
                        { ...existing, accountId: account.id, signature, signatureHtml },
                      ];
                      const saved = await api.saveAccountVoices(next);
                      setVoices(saved.voices);
                      setSignatureAccountId(null);
                      toast.success("Signature saved");
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(next) => !next && setConfirmId(null)}
        title={t("connections.disconnect")}
        description={t("connections.disconnectConfirm")}
        confirmLabel={t("connections.disconnect")}
        variant="destructive"
        busy={removing}
        onConfirm={() => confirmId && void remove(confirmId)}
      />
    </div>
  );
}
