import * as React from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Trash2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EmailDraft, EmailThreadMessage } from "@trailin/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { errorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { ThreadHistory } from "@/features/home/ThreadHistory";

/** One draft — click to read the full content right here, edit its body in place. */
export function DraftRow({
  accountId,
  draft,
  dateLabel,
  onDeleted,
  onSaved,
  onError,
  forceOpen,
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
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<{ body: string; cc: string } | null>(null);
  // Editable body state: `bodyDraft` is the live textarea value, `savedBody` is
  // the last-persisted baseline it's compared against for the dirty flag.
  const [bodyDraft, setBodyDraft] = React.useState("");
  const [savedBody, setSavedBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  // Thread context, fetched alongside the draft body. Absent (null) either
  // before load or when the draft doesn't reply to anything; a load failure
  // never blocks the draft view, it just sets threadFailed for a quiet note.
  const [thread, setThread] = React.useState<EmailThreadMessage[] | null>(null);
  const [threadFailed, setThreadFailed] = React.useState(false);
  const [threadOpen, setThreadOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);

  const loadDetail = React.useCallback(async () => {
    setThreadFailed(false);
    // Kick off both requests before awaiting either — a slow/failed thread
    // fetch must never delay or break the draft body.
    const threadPromise = draft.threadId
      ? api
          .draftThread(accountId, draft.threadId, draft.messageId)
          .catch(() => {
            setThreadFailed(true);
            return null;
          })
      : Promise.resolve(null);
    try {
      const [detailResult, threadResult] = await Promise.all([
        api.draftDetail(accountId, draft.id),
        threadPromise,
      ]);
      setDetail(detailResult);
      setBodyDraft(detailResult.body);
      setSavedBody(detailResult.body);
      if (threadResult) setThread(threadResult.messages);
    } catch (err) {
      onError(errorMessage(err));
      setOpen(false);
    }
  }, [accountId, draft.id, draft.threadId, draft.messageId, onError]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) await loadDetail();
  };

  // Opened from the search palette: expand, fetch and scroll to it even if it
  // was already rendered collapsed.
  React.useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    if (!detail) void loadDetail();
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Only re-run when the palette re-targets this row, not on every detail/loadDetail change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  const discard = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.deleteDraft(accountId, draft.id);
      onDeleted();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const dirty = bodyDraft !== savedBody;

  const cancelEdit = () => setBodyDraft(savedBody);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      await api.updateDraft(accountId, draft.id, { body: bodyDraft });
      setSavedBody(bodyDraft);
      toast.success(t("common.saved"));
      onSaved();
    } catch (err) {
      // Keep the typed text — only the banner reflects the failure.
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={rowRef} className="scroll-mt-4 rounded-lg bg-surface-2">
      <div className="flex w-full items-center justify-between gap-3 px-3.5 py-3">
        <button
          type="button"
          onClick={() => void toggle()}
          className="flex flex-1 min-w-0 items-center gap-2.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {draft.subject || t("drafts.noSubject")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {draft.to && `${t("drafts.to")} ${draft.to}`}
              {draft.to && draft.date && " · "}
              {dateLabel(draft.date)}
            </p>
            {!open && draft.snippet && (
              <p className="truncate text-xs text-muted-foreground/70">{draft.snippet}</p>
            )}
          </div>
        </button>
        <div className="flex items-center shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={() => window.open(draft.webUrl, "_blank", "noopener,noreferrer")}
            title={t("drafts.open")}
            aria-label={t("drafts.open")}
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:bg-accent/10 hover:text-accent"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("trailin:show-chat"));
              if (draft.conversationId) {
                // The agent wrote this draft — reopen that conversation, with
                // its context and draft card, instead of starting cold.
                window.dispatchEvent(
                  new CustomEvent("trailin:open-chat", { detail: draft.conversationId })
                );
              } else {
                // Draft from outside Trailin (or an unlinked older one): a
                // fresh chat with a prefilled ask is the best we can do.
                window.dispatchEvent(
                  new CustomEvent("trailin:prefill-chat", {
                    detail: { text: t("drafts.refinePrompt", { subject: draft.subject }) },
                  })
                );
              }
            }}
            title={draft.conversationId ? t("drafts.refineInChat") : t("drafts.refine")}
            aria-label={draft.conversationId ? t("drafts.refineInChat") : t("drafts.refine")}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t("drafts.discard")}
            aria-label={t("drafts.discard")}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5 pt-1">
          {!detail ? (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common.loading")}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 pt-2 text-[14px]">
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
                {draft.subject && (
                  <div>
                    <span className="font-medium mr-1.5">{t("drafts.subject", "Subject")}:</span>
                    <span className="text-foreground/90">{draft.subject}</span>
                  </div>
                )}
              </div>

              {thread && thread.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setThreadOpen((v) => !v)}
                    aria-expanded={threadOpen}
                    className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {threadOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    )}
                    {t("drafts.conversation", { count: thread.length })}
                  </button>
                  {threadOpen && <ThreadHistory messages={thread} />}
                </div>
              )}
              {/* A failed thread fetch is context lost, not a draft-level error — no ErrorBanner. */}
              {threadFailed && (
                <p className="text-xs text-muted-foreground/70">{t("drafts.threadLoadFailed")}</p>
              )}

              <div className="mt-1 flex flex-col gap-2">
                <Textarea
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  placeholder={t("drafts.emptyBodyText")}
                  rows={Math.max(6, bodyDraft.split("\n").length)}
                  className="resize-none text-[14px] leading-relaxed text-foreground/90"
                />
                {dirty && (
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" onClick={() => void save()} disabled={saving}>
                      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {saving ? t("common.saving") : t("drafts.save")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("drafts.discard")}
        description={t("drafts.discardConfirm")}
        confirmLabel={t("drafts.discard")}
        variant="destructive"
        busy={busy}
        onConfirm={() => void discard()}
      />
    </div>
  );
}
