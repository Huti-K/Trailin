import type { EmailDraft } from "@trailin/shared";
import { ChevronRight, Mail, Send, Sparkles, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DraftActionDialog, useDraftActions } from "@/components/draftActions";
import { ThreadHistory } from "@/components/ThreadHistory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRow } from "@/components/ui/feedback";
import { IconChip } from "@/components/ui/icon-chip";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { OpenExternalButton } from "@/components/ui/open-external-button";
import { Textarea } from "@/components/ui/textarea";
import { revealChat, sendChatCommand } from "@/features/chat/controller";
import { NewDot } from "@/features/home/seen";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn, errorMessage, rowTransition, withViewTransition } from "@/lib/utils";

/** One draft — click to read the full content right here, edit its body in place. */
export function DraftRow({
  accountId,
  draft,
  dateLabel,
  onDeleted,
  onSaved,
  onError,
  forceOpen,
  isNew,
}: {
  accountId: string;
  draft: EmailDraft;
  dateLabel: (iso: string) => string;
  onDeleted: () => void;
  /** Called after a body save succeeds, so the list refetches (snippet/date). */
  onSaved: () => void;
  onError: (message: string | null) => void;
  /** True when this draft was opened via the search palette — auto-expand and scroll to it. */
  forceOpen?: boolean;
  /** Drafted since the user last looked — fronts the subject with the new dot. */
  isNew?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<{ body: string; cc: string } | null>(null);
  // Editable body/subject state: the `*Draft` values are the live field
  // values, `saved*` are the last-persisted baselines they're compared
  // against for the dirty flag. Subject starts from the list row's value —
  // unlike body it never needs a fetch, there's no separate subject endpoint.
  const [bodyDraft, setBodyDraft] = React.useState("");
  const [savedBody, setSavedBody] = React.useState("");
  const [subjectDraft, setSubjectDraft] = React.useState(draft.subject);
  const [savedSubject, setSavedSubject] = React.useState(draft.subject);
  const [saving, setSaving] = React.useState(false);
  // True right after a successful send — the row shows a brief "Sent" state
  // until the drafts SSE topic fires and the parent list refetch removes it.
  const [sent, setSent] = React.useState(false);
  // Discarded rows leave at once rather than waiting on the refetch, so the
  // view transition has a frame to animate the gap closed.
  const [discarded, setDiscarded] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);

  const loadDetail = React.useCallback(async () => {
    try {
      const detailResult = await api.draftDetail(accountId, draft.id);
      setDetail(detailResult);
      setBodyDraft(detailResult.body);
      setSavedBody(detailResult.body);
    } catch (err) {
      onError(errorMessage(err));
      setOpen(false);
    }
  }, [accountId, draft.id, onError]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) await loadDetail();
  };

  // Opened from the search palette: expand, fetch and scroll to it even if it
  // was already rendered collapsed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the palette re-targets this row, not on every detail/loadDetail change
  React.useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    if (!detail) void loadDetail();
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [forceOpen]);

  const dirty = bodyDraft !== savedBody || subjectDraft !== savedSubject;

  const cancelEdit = () => {
    setBodyDraft(savedBody);
    setSubjectDraft(savedSubject);
  };

  /** PATCHes only the fields that changed from their saved baseline. */
  const savePatch = (): { body?: string; subject?: string } => ({
    ...(bodyDraft !== savedBody && { body: bodyDraft }),
    ...(subjectDraft !== savedSubject && { subject: subjectDraft }),
  });

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      await api.updateDraft(accountId, draft.id, savePatch());
      setSavedBody(bodyDraft);
      setSavedSubject(subjectDraft);
      toast.success(t("common.saved"));
      onSaved();
    } catch (err) {
      // Keep the typed text — only the banner reflects the failure.
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const actions = useDraftActions({
    // Flushes any unsaved edits first, then sends the draft as-is.
    send: async () => {
      onError(null);
      try {
        if (dirty) {
          await api.updateDraft(accountId, draft.id, savePatch());
          setSavedBody(bodyDraft);
          setSavedSubject(subjectDraft);
        }
        await api.sendDraft(accountId, draft.id);
        withViewTransition(() => setSent(true));
        toast.success(t("drafts.sentToast"));
      } catch (err) {
        onError(errorMessage(err));
      }
    },
    discard: async () => {
      onError(null);
      try {
        await api.deleteDraft(accountId, draft.id);
        withViewTransition(() => setDiscarded(true));
        onDeleted();
      } catch (err) {
        onError(errorMessage(err));
      }
    },
  });

  // Sending removes the draft upstream — the row itself disappears once the
  // drafts SSE topic fires and the parent list refetches. Until then, show a
  // quiet terminal line instead of live controls.
  if (discarded) return null;

  if (sent) {
    return (
      <ListRow>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{subjectDraft || t("drafts.noSubject")}</p>
          {draft.to && <p className="truncate text-xs text-muted-foreground">{draft.to}</p>}
        </div>
        <Badge variant="success">{t("drafts.sent")}</Badge>
      </ListRow>
    );
  }

  const meta = [draft.to ? `${t("drafts.to")} ${draft.to}` : null, dateLabel(draft.date)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={rowRef}
      className="surface surface-hover scroll-mt-4 rounded-lg"
      style={rowTransition(draft.id)}
    >
      <div className="flex w-full items-center gap-2 px-2.5 py-2.5">
        <button
          type="button"
          onClick={() => void toggle()}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
        >
          <IconChip size="sm">
            <Mail />
          </IconChip>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
              {isNew && <NewDot />}
              {subjectDraft || t("drafts.noSubject")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {meta}
              {!open && draft.snippet && (
                <span className="text-muted-foreground/70"> · {draft.snippet}</span>
              )}
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <OpenExternalButton url={draft.webUrl} label={t("drafts.open")} />
          <Button
            variant="ghost"
            size="icon-xs"
            className="icon-refine hover:bg-accent/10 hover:text-accent"
            onClick={(e) => {
              e.stopPropagation();
              revealChat();
              if (draft.conversationId) {
                // The agent wrote this draft — reopen that conversation, with
                // its context and draft card, instead of starting cold.
                sendChatCommand({ kind: "open", conversationId: draft.conversationId });
              } else {
                // Draft from outside Trailin (or an unlinked older one): a
                // fresh chat with a prefilled ask is the best we can do.
                sendChatCommand({
                  kind: "prefill",
                  text: t("drafts.refinePrompt", { subject: draft.subject }),
                });
              }
            }}
            title={draft.conversationId ? t("drafts.refineInChat") : t("drafts.refine")}
            aria-label={draft.conversationId ? t("drafts.refineInChat") : t("drafts.refine")}
          >
            <Sparkles />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="icon-send"
            onClick={() => actions.arm("send")}
            disabled={actions.busy}
            loading={actions.busy && actions.pending === "send"}
            title={t("drafts.send")}
            aria-label={t("drafts.send")}
          >
            <Send />
          </Button>
          <Button
            variant="ghost-danger"
            size="icon-xs"
            className="icon-discard"
            onClick={() => actions.arm("discard")}
            disabled={actions.busy}
            loading={actions.busy && actions.pending === "discard"}
            title={t("drafts.discard")}
            aria-label={t("drafts.discard")}
          >
            <Trash2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={open}
            title={t(open ? "common.collapse" : "common.expand")}
            aria-label={t(open ? "common.collapse" : "common.expand")}
            onClick={() => void toggle()}
          >
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
          </Button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-3 px-2.5 pb-3">
          {!detail ? (
            <LoadingRow className="py-1 text-xs" />
          ) : (
            <div className="flex flex-col gap-2.5 pl-8 pt-1 text-sm">
              <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
                {draft.to && (
                  <div>
                    <span className="font-medium mr-1.5">{t("drafts.to")}:</span>
                    {draft.to}
                  </div>
                )}
                {detail.cc && (
                  <div>
                    <span className="font-medium mr-1.5">{t("drafts.cc")}:</span>
                    {detail.cc}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 font-medium">{t("drafts.subject")}:</span>
                  <Input
                    value={subjectDraft}
                    onChange={(e) => setSubjectDraft(e.target.value)}
                    placeholder={t("drafts.noSubject")}
                    disabled={actions.busy}
                    className="h-7 flex-1 px-2 py-0 text-[13px] text-foreground/90"
                  />
                </div>
              </div>

              <div className="mt-1 flex flex-col gap-2">
                <Textarea
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  placeholder={t("drafts.emptyBodyText")}
                  disabled={actions.busy}
                  className="field-sizing-content min-h-32 resize-none text-sm leading-relaxed text-foreground/90"
                />
                {dirty && (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={cancelEdit}
                      disabled={saving || actions.busy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void save()}
                      disabled={actions.busy}
                      loading={saving}
                    >
                      {saving ? t("common.saving") : t("drafts.save")}
                    </Button>
                  </div>
                )}
              </div>

              <ThreadHistory accountId={accountId} threadId={draft.threadId} />
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
          send: { title: t("drafts.send"), description: t("drafts.sendConfirm") },
          discard: { title: t("drafts.discard"), description: t("drafts.discardConfirm") },
        }}
      />
    </div>
  );
}
