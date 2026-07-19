import type { AgentCard } from "@trailin/shared";
import { formatFileSize } from "@trailin/shared";
import { BookmarkCheck, Paperclip, PenLine } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DraftActionDialog, useDraftActions } from "@/components/draftActions";
import { ThreadHistory } from "@/components/ThreadHistory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OpenExternalButton } from "@/components/ui/open-external-button";
import { api, isNotFound } from "@/lib/api";
import { toast } from "@/lib/toast";
import { CardBodyText, CardShell } from "./CardShell";

type EmailDraftData = Extract<AgentCard, { kind: "email_draft" }>;

/** The draft's fate as this card knows it. `open` covers both "still a live
 *  draft" and "we haven't checked yet" — the status fetch is a local DB read
 *  that resolves fast enough that a separate loading state isn't worth it.
 *  `gone` is a 404 hit while sending/discarding: the draft vanished upstream
 *  outside this card's own action. */
type DraftCardStatus = "open" | "sent" | "discarded" | "gone";

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
  // card falls back to a read-only preview.
  const canAct = Boolean(accountId);
  const keepKey = keepStorageKey(draft.draftId);

  const [status, setStatus] = React.useState<DraftCardStatus>("open");
  const [kept, setKept] = React.useState(() => canAct && localStorage.getItem(keepKey) === "1");

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

  const actions = useDraftActions({
    send: async () => {
      if (!accountId) return;
      try {
        await api.sendDraft(accountId, draft.draftId);
        setStatus("sent");
      } catch (err) {
        if (isNotFound(err)) setStatus("gone");
        else toast.error(err);
      }
    },
    discard: async () => {
      if (!accountId) return;
      try {
        await api.deleteDraft(accountId, draft.draftId);
        setStatus("discarded");
      } catch (err) {
        if (isNotFound(err)) setStatus("gone");
        else toast.error(err);
      }
    },
  });

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
          <OpenExternalButton
            url={webUrl}
            label={t("chat.cards.draft.open")}
            className="shrink-0"
          />
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

          {draft.attachments && draft.attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground tabular-nums">
              {draft.attachments.map((attachment) => (
                <span key={attachment.filename} className="flex items-center gap-1">
                  <Paperclip className="h-3 w-3 shrink-0" />
                  {attachment.filename}
                  {attachment.size !== undefined && ` (${formatFileSize(attachment.size)})`}
                </span>
              ))}
            </div>
          )}

          {accountId && draft.threadId && (
            <ThreadHistory accountId={accountId} threadId={draft.threadId} />
          )}

          {canAct && (
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={keep} disabled={actions.busy}>
                {t("chat.cards.draft.keep")}
              </Button>
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={() => actions.arm("discard")}
                disabled={actions.busy}
              >
                {t("chat.cards.draft.discard")}
              </Button>
              <Button size="sm" onClick={() => actions.arm("send")} disabled={actions.busy}>
                {t("chat.cards.draft.send")}
              </Button>
            </div>
          )}
        </div>
      )}
      <DraftActionDialog
        pending={actions.pending}
        busy={actions.busy}
        onClose={actions.close}
        onConfirm={() => void actions.confirm()}
        labels={{
          send: {
            title: t("chat.cards.draft.send"),
            description: t("chat.cards.draft.sendConfirm"),
          },
          discard: {
            title: t("chat.cards.draft.discard"),
            description: t("chat.cards.draft.discardConfirm"),
          },
        }}
      />
    </CardShell>
  );
}
