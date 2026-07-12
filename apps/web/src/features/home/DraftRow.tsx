import type { EmailDraft, EmailThreadMessage } from "@trailin/shared";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ThreadHistory } from "@/features/home/ThreadHistory";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { errorMessage, openExternal } from "@/lib/utils";

/** One action pending confirmation in the shared armed-confirm dialog below. */
type PendingAction = "discard" | "send" | null;

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
  // Editable body/subject state: the `*Draft` values are the live field
  // values, `saved*` are the last-persisted baselines they're compared
  // against for the dirty flag. Subject starts from the list row's value —
  // unlike body it never needs a fetch, there's no separate subject endpoint.
  const [bodyDraft, setBodyDraft] = React.useState("");
  const [savedBody, setSavedBody] = React.useState("");
  const [subjectDraft, setSubjectDraft] = React.useState(draft.subject);
  const [savedSubject, setSavedSubject] = React.useState(draft.subject);
  const [saving, setSaving] = React.useState(false);
  // Thread context, fetched alongside the draft body. Absent (null) either
  // before load or when the draft doesn't reply to anything; a load failure
  // never blocks the draft view, it just sets threadFailed for a quiet note.
  const [thread, setThread] = React.useState<EmailThreadMessage[] | null>(null);
  const [threadFailed, setThreadFailed] = React.useState(false);
  const [threadOpen, setThreadOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  // True right after a successful send — the row shows a brief "Sent" state
  // until the drafts SSE topic fires and the parent list refetch removes it.
  const [sent, setSent] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement>(null);

  const loadDetail = React.useCallback(async () => {
    setThreadFailed(false);
    // Kick off both requests before awaiting either — a slow/failed thread
    // fetch must never delay or break the draft body.
    const threadPromise = draft.threadId
      ? api.draftThread(accountId, draft.threadId, draft.messageId).catch(() => {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the palette re-targets this row, not on every detail/loadDetail change
  React.useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    if (!detail) void loadDetail();
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      setPendingAction(null);
    }
  };

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

  /** Flushes any unsaved edits first, then sends the draft as-is. */
  const send = async () => {
    setBusy(true);
    onError(null);
    try {
      if (dirty) {
        await api.updateDraft(accountId, draft.id, savePatch());
        setSavedBody(bodyDraft);
        setSavedSubject(subjectDraft);
      }
      await api.sendDraft(accountId, draft.id);
      setSent(true);
      toast.success(t("drafts.sentToast"));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  };

  // Sending removes the draft upstream — the row itself disappears once the
  // drafts SSE topic fires and the parent list refetches. Until then, show a
  // quiet terminal line instead of live controls.
  if (sent) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{subjectDraft || t("drafts.noSubject")}</p>
          {draft.to && <p className="truncate text-xs text-muted-foreground">{draft.to}</p>}
        </div>
        <Badge variant="success">{t("drafts.sent")}</Badge>
      </div>
    );
  }

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
            <p className="truncate text-sm font-medium">{subjectDraft || t("drafts.noSubject")}</p>
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
            size="icon-sm"
            onClick={() => openExternal(draft.webUrl)}
            title={t("drafts.open")}
            aria-label={t("drafts.open")}
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:bg-accent/10 hover:text-accent"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("trailin:show-chat"));
              if (draft.conversationId) {
                // The agent wrote this draft — reopen that conversation, with
                // its context and draft card, instead of starting cold.
                window.dispatchEvent(
                  new CustomEvent("trailin:open-chat", { detail: draft.conversationId }),
                );
              } else {
                // Draft from outside Trailin (or an unlinked older one): a
                // fresh chat with a prefilled ask is the best we can do.
                window.dispatchEvent(
                  new CustomEvent("trailin:prefill-chat", {
                    detail: { text: t("drafts.refinePrompt", { subject: draft.subject }) },
                  }),
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
            size="icon-sm"
            onClick={() => setPendingAction("send")}
            disabled={busy}
            title={t("drafts.send")}
            aria-label={t("drafts.send")}
          >
            {busy && pendingAction === "send" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPendingAction("discard")}
            disabled={busy}
            className="hover:bg-destructive/10 hover:text-destructive"
            title={t("drafts.discard")}
            aria-label={t("drafts.discard")}
          >
            {busy && pendingAction === "discard" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
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
            <div className="flex flex-col gap-2.5 pt-2 text-sm">
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
                    disabled={busy}
                    className="h-7 flex-1 px-2 py-0 text-[13px] text-foreground/90"
                  />
                </div>
              </div>

              {thread && thread.length > 0 && (
                <div className="flex flex-col gap-2">
                  <DisclosureToggle open={threadOpen} onToggle={() => setThreadOpen((v) => !v)}>
                    {t("drafts.conversation", { count: thread.length })}
                  </DisclosureToggle>
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
                  disabled={busy}
                  className="resize-none text-sm leading-relaxed text-foreground/90"
                />
                {dirty && (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={cancelEdit}
                      disabled={saving || busy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" onClick={() => void save()} disabled={saving || busy}>
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
        open={pendingAction !== null}
        onOpenChange={(next) => {
          if (!next) setPendingAction(null);
        }}
        title={pendingAction === "send" ? t("drafts.send") : t("drafts.discard")}
        description={
          pendingAction === "send" ? t("drafts.sendConfirm") : t("drafts.discardConfirm")
        }
        confirmLabel={pendingAction === "send" ? t("drafts.send") : t("drafts.discard")}
        variant={pendingAction === "send" ? "default" : "destructive"}
        busy={busy}
        onConfirm={() => void (pendingAction === "send" ? send() : discard())}
      />
    </div>
  );
}
