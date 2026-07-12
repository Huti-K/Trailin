import type { NewsletterSender } from "@trailin/shared";
import { ChevronDown, Loader2, Mail, SearchX } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/feedback";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ContactAvatar,
  LANE_INITIAL_VISIBLE,
  LANE_SEARCH_THRESHOLD,
  LANE_VISIBLE_STEP,
  LaneSearchField,
  stagger,
} from "@/features/contacts/shared";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/dates";
import { useServerEvents } from "@/lib/serverEvents";
import { toast } from "@/lib/toast";
import { errorMessage } from "@/lib/utils";

/** How long after a request queued/in-flight sends are still expected; only mail past this counts as evidence the unsubscribe failed. */
const GRACE_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * True when this sender's unsubscribe evidently failed: no protocol confirms
 * an unsubscribe, so mail still arriving well past the request (beyond the
 * grace period that covers already-queued sends) is the only positive
 * evidence it did NOT work.
 */
function unsubscribeFailed(sender: NewsletterSender): boolean {
  return (
    sender.unsubscribeRequestedAt !== undefined &&
    Date.parse(sender.lastContactAt) > Date.parse(sender.unsubscribeRequestedAt) + GRACE_MS
  );
}

/**
 * Newsletters lane: an action queue, not a directory. Only bulk senders
 * (contacts rows with kind="bulk", see email/contacts/ + email/unsubscribe/)
 * with a working one-click unsubscribe are listed; senders with no
 * automatable mechanism (browse/mailto/none) and ones still resolving never
 * appear. Requesting an unsubscribe removes the row — the stamp is persisted
 * server-side (contacts.unsubscribe_requested_at), the local `requested` set
 * only bridges the moment until the "contacts" event refetch — and it only
 * returns, flagged, if mail keeps arriving well past the request (see
 * unsubscribeFailed above).
 */
export function NewslettersLane() {
  const { t } = useTranslation();
  const [senders, setSenders] = React.useState<NewsletterSender[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [requested, setRequested] = React.useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = React.useState<NewsletterSender | null>(null);
  const [busyAddress, setBusyAddress] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(LANE_INITIAL_VISIBLE);

  const refresh = React.useCallback(() => {
    api
      .newsletters()
      .then((rows) => {
        setSenders(rows);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  useServerEvents(["contacts"], refresh);

  // Actionable senders only: a working one-click unsubscribe, and either
  // never requested or evidently failed (so the action is worth re-offering).
  const actionable = React.useMemo(
    () =>
      (senders ?? []).filter(
        (s) =>
          s.unsubscribe.state === "one_click" &&
          !requested.has(s.address) &&
          (s.unsubscribeRequestedAt === undefined || unsubscribeFailed(s)),
      ),
    [senders, requested],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actionable;
    return actionable.filter(
      (s) => s.address.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q),
    );
  }, [actionable, query]);

  // Reset the cap whenever the query narrows the filtered set, so "show more"
  // never sits past the end. query isn't read in the body — it's the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query drives the reset, not the effect body
  React.useEffect(() => {
    setVisible(LANE_INITIAL_VISIBLE);
  }, [query]);

  const confirmUnsubscribe = async () => {
    if (!pending) return;
    // A bulk sender is only listed once it has a mirrored message, which
    // always ties it to at least one connected account — this is a defensive
    // fallback, not an expected path.
    const accountId = pending.accounts[0];
    if (!accountId) {
      toast.error(new Error(t("errors.request")));
      setPending(null);
      return;
    }
    setBusyAddress(pending.address);
    try {
      await api.unsubscribeNewsletter(pending.address, accountId);
      setRequested((prev) => new Set(prev).add(pending.address));
      toast.success(t("contacts.newsletters.unsubscribeRequested"));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyAddress(null);
      setPending(null);
    }
  };

  if (senders === null) {
    return loadError ? (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner>{loadError}</ErrorBanner>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("common.retry")}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const empty = actionable.length === 0;
  const shown = filtered.slice(0, visible);
  const remaining = filtered.length - shown.length;

  return (
    <div className="flex flex-col gap-4">
      {actionable.length > LANE_SEARCH_THRESHOLD && (
        <LaneSearchField
          value={query}
          onChange={setQuery}
          placeholder={t("contacts.newsletters.searchPlaceholder")}
        />
      )}

      {empty ? (
        <EmptyState
          icon={Mail}
          title={t("contacts.newsletters.emptyTitle")}
          description={t("contacts.newsletters.emptyBody")}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t("common.noResults")}
          description={t("common.noResultsBody", { query })}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              {t("common.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((sender, i) => (
            <div key={sender.address} className="animate-in-up" style={stagger(i)}>
              <NewsletterRow
                sender={sender}
                busy={busyAddress === sender.address}
                onUnsubscribe={() => setPending(sender)}
              />
            </div>
          ))}
          {remaining > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setVisible((v) => v + LANE_VISIBLE_STEP)}
            >
              <ChevronDown />
              {t("library.showMore", { count: remaining })}
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={t("contacts.newsletters.unsubscribeConfirmTitle", {
          name: pending?.displayName || pending?.address || "",
        })}
        description={t("contacts.newsletters.unsubscribeConfirmBody", {
          name: pending?.displayName || pending?.address || "",
        })}
        confirmLabel={t("contacts.newsletters.unsubscribe")}
        variant="destructive"
        busy={pending !== null && busyAddress === pending.address}
        onConfirm={() => void confirmUnsubscribe()}
      />
    </div>
  );
}

function NewsletterRow({
  sender,
  busy,
  onUnsubscribe,
}: {
  sender: NewsletterSender;
  busy: boolean;
  onUnsubscribe: () => void;
}) {
  const { t, i18n } = useTranslation();
  const label = sender.displayName || sender.address;
  // Every listed row is actionable by construction (see the lane's filter) —
  // the only extra state worth a tell is a previous request that evidently
  // failed, which is why the row is back.
  const stillReceiving = unsubscribeFailed(sender);

  return (
    <ListRow>
      <ContactAvatar label={label} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{sender.address}</p>
        <p className="truncate text-2xs text-muted-foreground/70">
          {t("contacts.newsletters.frequency", {
            count: sender.messageCount,
            when: relativeTime(sender.lastContactAt, i18n.language),
          })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {stillReceiving && (
          <Badge variant="warning" title={t("contacts.newsletters.stillReceivingHint")}>
            {t("contacts.newsletters.stillReceiving")}
          </Badge>
        )}
        <Button variant="outline" size="sm" onClick={onUnsubscribe} disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("contacts.newsletters.unsubscribe")}
        </Button>
      </div>
    </ListRow>
  );
}
