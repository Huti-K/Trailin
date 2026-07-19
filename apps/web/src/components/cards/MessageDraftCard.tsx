import type { AgentCard } from "@trailin/shared";
import { MessageSquare } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DraftActionDialog, useDraftActions } from "@/components/draftActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, isNotFound } from "@/lib/api";
import { toast } from "@/lib/toast";
import { CardBodyText, CardShell } from "./CardShell";

type MessageDraftData = Extract<AgentCard, { kind: "message_draft" }>;

/** Same statuses as EmailDraftCard; `gone` is a 404 while sending/discarding. */
type Status = "open" | "sent" | "discarded" | "gone";

const CHANNEL_LABELS: Record<string, string> = { whatsapp: "WhatsApp" };

/**
 * A pending outbound message (WhatsApp and future channels), approved with the
 * same Keep/Discard/Send machinery as an email draft. Sending dispatches
 * through POST /api/outbound/:id/send — the click is the authorization.
 */
export function MessageDraftCard({ card }: { card: MessageDraftData }) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<Status>("open");

  React.useEffect(() => {
    let cancelled = false;
    void api
      .outboundStatus(card.draftId)
      .then((result) => {
        if (!cancelled && result.status !== "open") setStatus(result.status);
      })
      .catch(() => {
        // 404 or any failure: treat as unknown, keep live actions.
      });
    return () => {
      cancelled = true;
    };
  }, [card.draftId]);

  const actions = useDraftActions({
    send: async () => {
      try {
        await api.sendOutbound(card.draftId);
        setStatus("sent");
      } catch (err) {
        if (isNotFound(err)) setStatus("gone");
        else toast.error(err);
      }
    },
    discard: async () => {
      try {
        await api.discardOutbound(card.draftId);
        setStatus("discarded");
      } catch (err) {
        if (isNotFound(err)) setStatus("gone");
        else toast.error(err);
      }
    },
  });

  const channelLabel = CHANNEL_LABELS[card.channel] ?? card.channel;

  return (
    <CardShell
      icon={MessageSquare}
      label={t("chat.cards.messageDraft.badge", { channel: channelLabel })}
      title={card.targetLabel || channelLabel}
    >
      {status === "sent" ? (
        <div className="px-4 pb-4 pt-0.5">
          <Badge variant="success">{t("chat.cards.messageDraft.sentLabel")}</Badge>
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
          <CardBodyText text={card.body} />
          <div className="flex justify-end gap-2 pt-1">
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
            description: t("chat.cards.messageDraft.sendConfirm"),
          },
          discard: {
            title: t("chat.cards.draft.discard"),
            description: t("chat.cards.messageDraft.discardConfirm"),
          },
        }}
      />
    </CardShell>
  );
}
