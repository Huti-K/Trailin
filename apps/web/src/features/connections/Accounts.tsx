import {
  type AccountColor,
  type AccountPermissions,
  type ConnectedAccount,
  EMAIL_APP_LABELS,
  type EmailApp,
  type PipedreamApp,
  type VoiceLearnRun,
} from "@trailin/shared";
import { Inbox, LogOut, Plus, RotateCcw, Settings } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { AppIcon } from "@/components/ui/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorPicker } from "@/components/ui/color-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { GroupLabel } from "@/components/ui/group-label";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { OptionRow } from "@/components/ui/option-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  AccountPermissionsEditor,
  type PermissionGrants,
  READ_ONLY_GRANTS,
} from "@/features/connections/AccountPermissions";
import {
  OnOfficeAccountRow,
  OnOfficeForm,
  OnOfficePermissionsEditor,
  OnOfficePickerButton,
  useOnOfficeStatus,
} from "@/features/connections/OnOffice";
import {
  useWhatsAppStatus,
  WhatsAppAccountRow,
  WhatsAppPairingCard,
  WhatsAppPermissionsEditor,
  WhatsAppPickerButton,
} from "@/features/connections/WhatsApp";
import { isEmailApp } from "@/lib/accounts";
import { api } from "@/lib/api";
import { useServerEvents } from "@/lib/serverEvents";
import { toast } from "@/lib/toast";
import { stagger, UNASSIGNED_ACCOUNT_COLOR } from "@/lib/utils";

const CONNECT_POLL_INTERVAL_MS = 3000;
/** Give up watching for a linked account after this long (or at token expiry). */
const CONNECT_WATCH_TIMEOUT_MS = 10 * 60_000;

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
    <OptionRow
      fill="recessed"
      onClick={() => onConnect(app.slug)}
      disabled={busy !== null}
      icon={<AppIcon src={app.imgSrc} className="h-5 w-5" />}
      label={app.name}
      trailing={
        busy === app.slug ? (
          <Spinner className="shrink-0 text-muted-foreground" />
        ) : (
          <Plus className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        )
      }
    />
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
      <GroupLabel as="p" size="sm" className="px-1">
        {heading}
      </GroupLabel>
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
 * Shared between the first-run setup and Settings → Accounts.
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
  // Each account's latest automatic voice-learn attempt — "running" shows a
  // progress badge on the row, "error" a failure badge plus the retry button.
  const [voiceRuns, setVoiceRuns] = React.useState<VoiceLearnRun[]>([]);
  const [colors, setColors] = React.useState<AccountColor[]>([]);
  // Per-account permission grants; an account without a record is read-only.
  const [permissions, setPermissions] = React.useState<AccountPermissions[]>([]);
  const [permissionsAccountId, setPermissionsAccountId] = React.useState<string | null>(null);
  const [onOfficePermsOpen, setOnOfficePermsOpen] = React.useState(false);
  // onOffice is a native (non-Pipedream) CRM connection surfaced in the same
  // picker and accounts list; it authenticates with a token + secret, so its
  // picker entry opens the credential form instead of the Connect popup.
  const { status: onOffice, refresh: refreshOnOffice } = useOnOfficeStatus();
  const [onOfficeFormOpen, setOnOfficeFormOpen] = React.useState(false);
  // WhatsApp is a native personal-account link paired by QR scan, so its
  // picker entry opens the pairing card instead of the Connect popup.
  const { status: whatsApp, refresh: refreshWhatsApp } = useWhatsAppStatus();
  const [whatsAppPairingOpen, setWhatsAppPairingOpen] = React.useState(false);
  const [whatsAppPermsOpen, setWhatsAppPermsOpen] = React.useState(false);

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

  const loadVoiceRuns = React.useCallback(async () => {
    try {
      setVoiceRuns(await api.voiceLearnRuns());
    } catch {
      /* the badges just stay absent */
    }
  }, []);

  const loadPermissions = React.useCallback(async () => {
    try {
      const { permissions: saved } = await api.accountPermissions();
      setPermissions(saved);
    } catch {
      /* rows just show as read-only until a reload */
    }
  }, []);

  const grantsFor = (accountId: string): PermissionGrants =>
    permissions.find((p) => p.accountId === accountId) ?? READ_ONLY_GRANTS;

  const persistPermissions = async (accountId: string, next: PermissionGrants) => {
    const merged = [
      ...permissions.filter((p) => p.accountId !== accountId),
      { accountId, ...next },
    ];
    const { permissions: saved } = await api.setAccountPermissions(merged);
    setPermissions(saved);
  };

  React.useEffect(() => {
    void loadVoiceRuns();
  }, [loadVoiceRuns]);

  // A learn attempt starting/finishing emits "learn" — refresh the row badges.
  useServerEvents(["learn"], () => {
    void loadVoiceRuns();
  });

  React.useEffect(() => {
    void loadPermissions();
    void Promise.all([load(), loadColors()]).then(([accts, saved]) => {
      if (accts && saved) void ensureColors(accts, saved);
    });
  }, [load, loadColors, loadPermissions, ensureColors]);

  // Stops the completion watch of the current connect attempt, if any.
  const stopWatchRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopWatchRef.current?.(), []);

  // The Connect Link finishes in an external browser tab, which can't signal
  // back — so watch the account list (each fetch is live from Pipedream)
  // until an account not in priorIds appears, then finish up like a
  // successful in-app connect: colors, voice learning, onChanged.
  const watchForNewAccount = (priorIds: Set<string>, expiresAt: string) => {
    stopWatchRef.current?.();
    let stopped = false;
    stopWatchRef.current = () => {
      stopped = true;
      setConnecting(false);
    };
    const expiry = Date.parse(expiresAt);
    const deadline = Math.min(
      Number.isNaN(expiry) ? Infinity : expiry,
      Date.now() + CONNECT_WATCH_TIMEOUT_MS,
    );
    void (async () => {
      while (!stopped && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, CONNECT_POLL_INTERVAL_MS));
        if (stopped) return;
        // Silent fetch: a transient Pipedream error must not toast every tick.
        const next = await api.pipedreamAccounts().catch(() => null);
        if (!next) continue;
        setAccounts(next);
        const added = next.find((a) => !priorIds.has(a.id));
        if (!added) continue;
        stopWatchRef.current = null;
        setConnecting(false);
        // The new account has no color yet — assign one against the latest
        // saved colors rather than waiting for a remount to pick it up.
        void loadColors().then((saved) => ensureColors(next, saved));
        // Start voice learning for a freshly linked email account right
        // away — no consent step. Should this trigger get lost, the
        // server's boot reconcile pass picks the account up.
        if (isEmailApp(added.app)) {
          void api
            .learnAccountVoice(added.id)
            .then(() => toast.success(t("connections.learnVoiceStarted", { name: added.name })))
            .catch((err: unknown) => toast.error(err));
        }
        onChanged?.();
        return;
      }
      if (!stopped) {
        stopWatchRef.current = null;
        setConnecting(false);
      }
    })();
  };

  const connect = async (app: string) => {
    setBusy(app);
    // Account ids present before this link, so the watch can single out the
    // one that gets added.
    const priorIds = new Set((accounts ?? []).map((a) => a.id));
    try {
      const token = await api.pipedreamConnectToken(app);
      // The Connect Link must open in the user's own browser (the desktop
      // shell routes window.open there): that's where their Pipedream and
      // provider sessions live, an embedded window has neither.
      window.open(token.connectLinkUrl, "_blank", "noopener");
      setPickerOpen(false);
      setQuery("");
      setConnecting(true);
      watchForNewAccount(priorIds, token.expiresAt);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  // Rerun a failed (or skipped) voice-learn attempt from the account row.
  const retryLearn = async (account: ConnectedAccount) => {
    try {
      await api.learnAccountVoice(account.id);
      toast.success(t("connections.learnVoiceStarted", { name: account.name }));
    } catch (err) {
      toast.error(err);
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

  // Account data changed server-side (connect, removal, recolor, permission
  // edit — possibly from another surface): re-pull everything. Colors are
  // skipped while a local color edit is still persisting; the debounced flush
  // above stays authoritative for what it is about to save.
  useServerEvents(["accounts"], () => {
    void loadPermissions();
    const colorState = colorPersistRef.current;
    const colorEditInFlight =
      colorState.timer !== null || colorState.saving || colorState.pending !== null;
    void Promise.all([load(), colorEditInFlight ? null : loadColors()]).then(([accts, saved]) => {
      if (accts && saved) void ensureColors(accts, saved);
    });
  });

  const colorFor = (accountId: string): AccountColor | undefined =>
    colors.find((c) => c.accountId === accountId);

  // Split the pre-search suggestions into "email apps" and "everything else",
  // so the picker shows email providers plus a taste of the wider catalog.
  const emailResults = (results ?? []).filter((a) => isEmailApp(a.slug));
  const moreResults = (results ?? []).filter((a) => !isEmailApp(a.slug));

  // Connected accounts grouped by app, one overline heading per provider;
  // insertion order follows the accounts list, so groups appear in
  // first-connected order.
  const accountGroups = (() => {
    const byApp = new Map<string, ConnectedAccount[]>();
    for (const account of accounts ?? []) {
      const label = appLabel(account);
      const group = byApp.get(label);
      if (group) group.push(account);
      else byApp.set(label, [account]);
    }
    return [...byApp.entries()];
  })();

  // Offer onOffice in the picker only until it's connected — after that it's
  // managed through its connected row below. Match its free-text search the way
  // Pipedream matches an app name.
  const onOfficeQueryMatch = (() => {
    const q = query.trim().toLowerCase();
    return q === "" || "onoffice".includes(q) || "crm".includes(q);
  })();
  const showOnOfficePick = onOffice !== null && !onOffice.configured && onOfficeQueryMatch;

  const openOnOfficeForm = () => {
    setPickerOpen(false);
    setQuery("");
    setOnOfficeFormOpen(true);
  };

  // Same footing for WhatsApp: offered in the picker only until it's linked.
  const whatsAppQueryMatch = (() => {
    const q = query.trim().toLowerCase();
    return q === "" || "whatsapp".includes(q) || "messaging".includes(q);
  })();
  const showWhatsAppPick = whatsApp !== null && !whatsApp.linked && whatsAppQueryMatch;

  const openWhatsAppPairing = () => {
    setPickerOpen(false);
    setQuery("");
    setWhatsAppPairingOpen(true);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4 pb-2">
          <h3 className="text-sm font-semibold tracking-tight">{t("connections.emailAccounts")}</h3>
          <Button size="sm" onClick={() => setPickerOpen((open) => !open)} loading={busy !== null}>
            <Plus />
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
            ) : results.length === 0 && !showOnOfficePick && !showWhatsAppPick ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {t("connections.noProvidersFound", { q: query.trim() })}
              </p>
            ) : query.trim() ? (
              <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto py-0.5">
                {showOnOfficePick && <OnOfficePickerButton onClick={openOnOfficeForm} />}
                {showWhatsAppPick && <WhatsAppPickerButton onClick={openWhatsAppPairing} />}
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
                {showOnOfficePick && (
                  <div className="flex flex-col gap-1.5">
                    <GroupLabel as="p" size="sm" className="px-1">
                      {t("connections.crmHeading")}
                    </GroupLabel>
                    <OnOfficePickerButton onClick={openOnOfficeForm} />
                  </div>
                )}
                {showWhatsAppPick && (
                  <div className="flex flex-col gap-1.5">
                    <GroupLabel as="p" size="sm" className="px-1">
                      {t("connections.messagingHeading")}
                    </GroupLabel>
                    <WhatsAppPickerButton onClick={openWhatsAppPairing} />
                  </div>
                )}
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
          <div className="flex items-center gap-2">
            <Spinner className="h-3 w-3 shrink-0" />
            <p className="text-xs text-muted-foreground">{t("connections.finishConnecting")}</p>
            <Button variant="ghost" size="sm" onClick={() => stopWatchRef.current?.()}>
              {t("common.cancel")}
            </Button>
          </div>
        )}

        {onOfficeFormOpen && onOffice && (
          <OnOfficeForm
            status={onOffice}
            onSaved={async () => {
              setOnOfficeFormOpen(false);
              await refreshOnOffice();
              onChanged?.();
            }}
            onClose={() => setOnOfficeFormOpen(false)}
          />
        )}

        {whatsAppPairingOpen && whatsApp && (
          <WhatsAppPairingCard
            status={whatsApp}
            onPaired={async () => {
              setWhatsAppPairingOpen(false);
              toast.success(t("whatsapp.pairedToast"));
              await refreshWhatsApp();
              onChanged?.();
            }}
            onClose={() => setWhatsAppPairingOpen(false)}
          />
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
        ) : accounts.length === 0 && !onOffice?.configured && !whatsApp?.linked ? (
          <EmptyState icon={Inbox} description={t("connections.noAccounts")} />
        ) : (
          <div className="flex flex-col gap-4">
            {accountGroups.map(([label, groupAccounts]) => (
              <div key={label} className="flex flex-col gap-1.5">
                <GroupLabel as="p" size="sm" className="px-1">
                  {label}
                </GroupLabel>
                {groupAccounts.map((account) => {
                  const flat = accounts.indexOf(account);
                  return (
                    <div
                      key={account.id}
                      className="animate-in-up flex flex-col gap-1.5"
                      style={{ ...stagger(flat), zIndex: accounts.length - flat }}
                    >
                      <ListRow className="relative">
                        <div className="flex min-w-0 items-center gap-3">
                          <ColorPicker
                            color={colorFor(account.id)?.hex ?? UNASSIGNED_ACCOUNT_COLOR}
                            onSelect={(hex) => updateColor(account.id, hex)}
                          />
                          <AppIcon src={account.imgSrc} />
                          <p className="min-w-0 truncate text-sm font-medium">{account.name}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {(() => {
                            // Voice-learn status: in-flight and failed attempts are
                            // shown; a finished learn needs no chip of its own.
                            const run = voiceRuns.find((r) => r.accountId === account.id);
                            if (run?.status === "running") {
                              return (
                                <Badge variant="muted">
                                  <Spinner className="h-3 w-3" />
                                  {t("connections.voiceLearning")}
                                </Badge>
                              );
                            }
                            if (run?.status === "error") {
                              return (
                                <>
                                  <Badge
                                    variant="destructive"
                                    data-tooltip={run.error ?? undefined}
                                  >
                                    {t("connections.voiceLearnFailed")}
                                  </Badge>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => void retryLearn(account)}
                                    aria-label={t("connections.voiceLearnRetry")}
                                    data-tooltip={t("connections.voiceLearnRetry")}
                                  >
                                    <RotateCcw />
                                  </Button>
                                </>
                              );
                            }
                            return null;
                          })()}
                          {!account.healthy && (
                            <Badge variant="destructive">{t("connections.unhealthy")}</Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() =>
                              setPermissionsAccountId((id) =>
                                id === account.id ? null : account.id,
                              )
                            }
                            aria-label={t("connections.permissions.edit")}
                            data-tooltip={t("connections.permissions.edit")}
                          >
                            <Settings />
                          </Button>
                          <Button
                            variant="ghost-danger"
                            size="icon-sm"
                            onClick={() => setConfirmId(account.id)}
                            aria-label={t("connections.disconnect")}
                            data-tooltip={t("connections.disconnect")}
                          >
                            <LogOut />
                          </Button>
                        </div>
                      </ListRow>
                      {permissionsAccountId === account.id && (
                        <AccountPermissionsEditor
                          account={account}
                          granted={grantsFor(account.id)}
                          onPersist={(next) => persistPermissions(account.id, next)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {onOffice?.configured && (
              <div className="flex flex-col gap-1.5">
                <GroupLabel as="p" size="sm" className="px-1">
                  {t("connections.crmHeading")}
                </GroupLabel>
                <div className="animate-in-up flex flex-col gap-1.5">
                  <OnOfficeAccountRow
                    status={onOffice}
                    onEdit={() => setOnOfficeFormOpen(true)}
                    onTogglePermissions={() => setOnOfficePermsOpen((open) => !open)}
                    onDisconnected={async () => {
                      await refreshOnOffice();
                      onChanged?.();
                    }}
                  />
                  {onOfficePermsOpen && (
                    <OnOfficePermissionsEditor status={onOffice} onChanged={refreshOnOffice} />
                  )}
                </div>
              </div>
            )}
            {whatsApp?.linked && (
              <div className="flex flex-col gap-1.5">
                <GroupLabel as="p" size="sm" className="px-1">
                  {t("connections.messagingHeading")}
                </GroupLabel>
                <div className="animate-in-up flex flex-col gap-1.5">
                  <WhatsAppAccountRow
                    status={whatsApp}
                    onTogglePermissions={() => setWhatsAppPermsOpen((open) => !open)}
                    onUnlinked={async () => {
                      await refreshWhatsApp();
                      onChanged?.();
                    }}
                  />
                  {whatsAppPermsOpen && (
                    <WhatsAppPermissionsEditor status={whatsApp} onChanged={refreshWhatsApp} />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(next) => !next && setConfirmId(null)}
        title={t("connections.disconnect")}
        description={t("connections.disconnectConfirm")}
        confirmLabel={t("connections.disconnect")}
        busy={removing}
        onConfirm={() => confirmId && void remove(confirmId)}
      />
    </div>
  );
}
