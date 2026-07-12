import type { AgentCard } from "@trailin/shared";
import { BookmarkCheck, ExternalLink, PenLine } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api, isNotFound } from "@/lib/api";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/utils";
import { CardBodyText, CardShell } from "./CardShell";

type EmailDraftData = Extract<AgentCard, { kind: "email_draft" }>;

/** The draft's fate as this card knows it. `open` covers both "still a live
 *  draft" and "we haven't checked yet" — the status fetch is a local DB read
 *  that resolves fast enough that a separate loading state isn't worth it.
 *  `gone` is a 404 hit while sending/discarding: the draft vanished upstream
 *  outside this card's own action. */
type DraftCardStatus = "open" | "sent" | "discarded" | "gone";

/** One action pending confirmation in the shared armed-confirm dialog below. */
type PendingAction = "send" | "discard" | null;

/** localStorage flag for a card manually collapsed via Keep — cleared by
 *  clicking the collapsed line back open. */
function keepStorageKey(draftId: string): string {
  return `trailin-draft-keep:${draftId}`;
}

/** The create-draft preview — the card most worth getting right, since it's what actually gets sent. */
export function EmailDraftCard({ card, color }: { card: EmailDraftData; color?: string }) {
  const { t } = useTranslation();
  const { account, draft } = card;
  const webUrl = draft.webUrl;
  const accountId = account?.accountId;
  // Without a known account there's nowhere to send/discard against — the
  // card falls back to a read-only preview, same as before this feature.
  const canAct = Boolean(accountId);
  const keepKey = keepStorageKey(draft.draftId);

  const [status, setStatus] = React.useState<DraftCardStatus>("open");
  const [kept, setKept] = React.useState(() => canAct && localStorage.getItem(keepKey) === "1");
  const [busy, setBusy] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);

  // Re-runs whenever `kept` flips back to false (re-expanding), so reopening
  // a kept card re-checks its fate instead of trusting a stale assumption.
  React.useEffect(() => {
    if (!accountId || kept) return;
    let cancelled = false;
    void api
      .draftStatus(accountId, draft.draftId)
      .then((result) => {
        if (!cancelled && result.status !== "open") setStatus(result.status);
      })
      .catch(() => {
        // 404 (no snapshot) or any other failure: treat as unknown, keep live actions.
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, draft.draftId, kept]);

  const keep = () => {
    localStorage.setItem(keepKey, "1");
    setKept(true);
  };

  const reopen = () => {
    localStorage.removeItem(keepKey);
    setKept(false);
  };

  const send = async () => {
    if (!accountId) return;
    setBusy(true);
    try {
      await api.sendDraft(accountId, draft.draftId);
      setStatus("sent");
    } catch (err) {
      if (isNotFound(err)) setStatus("gone");
      else toast.error(err);
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  };

  const discard = async () => {
    if (!accountId) return;
    setBusy(true);
    try {
      await api.deleteDraft(accountId, draft.draftId);
      setStatus("discarded");
    } catch (err) {
      if (isNotFound(err)) setStatus("gone");
      else toast.error(err);
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  };

  const recipients: Array<[string, string[] | undefined]> = [
    [t("chat.cards.draft.to"), draft.to],
    [t("chat.cards.draft.cc"), draft.cc],
    [t("chat.cards.draft.bcc"), draft.bcc],
  ];

  return (
    <CardShell
      icon={PenLine}
      label={t("chat.cards.draft.badge")}
      title={draft.subject || t("chat.cards.noSubject")}
      account={account}
      color={color}
      action={
        // The open-in-provider link stays meaningful for an open or
        // just-sent draft (the message still exists there); a
        // discarded/gone one has nothing left to open.
        webUrl && status !== "discarded" && status !== "gone" ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={() => openExternal(webUrl)}
            title={t("chat.cards.draft.open")}
            aria-label={t("chat.cards.draft.open")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        ) : undefined
      }
    >
      {kept ? (
        <div className="px-4 pb-4 pt-0.5">
          <button
            type="button"
            onClick={reopen}
            className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <BookmarkCheck className="h-3.5 w-3.5 shrink-0" />
            {t("chat.cards.draft.kept")}
          </button>
        </div>
      ) : status === "sent" ? (
        <div className="px-4 pb-4 pt-0.5">
          <Badge variant="success">{t("chat.cards.draft.sentLabel")}</Badge>
        </div>
      ) : status === "discarded" ? (
        <div className="px-4 pb-4 pt-0.5">
          <Badge variant="destructive">{t("chat.cards.draft.discardedLabel")}</Badge>
        </div>
      ) : status === "gone" ? (
        <div className="px-4 pb-4 pt-0.5">
          <Badge variant="muted">{t("chat.cards.draft.goneLabel")}</Badge>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 pb-4 pt-0.5">
          {/* Recipient header, set like a real mail header: mono labels, plain values. */}
          <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
            {recipients.map(
              ([label, list]) =>
                list &&
                list.length > 0 && (
                  <React.Fragment key={label}>
                    <span className="font-mono text-2xs text-muted-foreground">{label}</span>
                    <span className="truncate text-xs text-foreground/90">{list.join(", ")}</span>
                  </React.Fragment>
                ),
            )}
          </div>

          <CardBodyText text={draft.body} />

          {draft.signatureAppended && (
            <p className="text-xs text-muted-foreground/70">
              {t("chat.cards.draft.signatureNote")}
            </p>
          )}

          {canAct && (
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={keep} disabled={busy}>
                {t("chat.cards.draft.keep")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setPendingAction("discard")}
                disabled={busy}
              >
                {t("chat.cards.draft.discard")}
              </Button>
              <Button size="sm" onClick={() => setPendingAction("send")} disabled={busy}>
                {t("chat.cards.draft.send")}
              </Button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(next) => {
          if (!next) setPendingAction(null);
        }}
        title={
          pendingAction === "send" ? t("chat.cards.draft.send") : t("chat.cards.draft.discard")
        }
        description={
          pendingAction === "send"
            ? t("chat.cards.draft.sendConfirm")
            : t("chat.cards.draft.discardConfirm")
        }
        confirmLabel={
          pendingAction === "send" ? t("chat.cards.draft.send") : t("chat.cards.draft.discard")
        }
        variant={pendingAction === "send" ? "default" : "destructive"}
        busy={busy}
        onConfirm={() => void (pendingAction === "send" ? send() : discard())}
      />
    </CardShell>
  );
}
