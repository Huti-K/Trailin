import * as React from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** A draft action pending confirmation in the shared armed dialog. */
export type DraftAction = "send" | "discard";

/**
 * The arm → confirm → execute machinery every surface that sends or discards
 * a draft shares (Home's DraftRow, the chat's EmailDraftCard). The callbacks
 * own their surface's API call and error semantics — inline banner on one,
 * card status/toast on the other — while the hook owns arming, the busy
 * flag, and closing the dialog afterwards, so the two surfaces cannot drift
 * in how an action is confirmed.
 */
export function useDraftActions(callbacks: {
  send: () => Promise<void>;
  discard: () => Promise<void>;
}): {
  pending: DraftAction | null;
  busy: boolean;
  arm: (action: DraftAction) => void;
  close: () => void;
  confirm: () => Promise<void>;
} {
  const [pending, setPending] = React.useState<DraftAction | null>(null);
  const [busy, setBusy] = React.useState(false);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await (pending === "send" ? callbacks.send() : callbacks.discard());
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return {
    pending,
    busy,
    arm: (action: DraftAction) => setPending(action),
    close: () => setPending(null),
    confirm,
  };
}

/** The armed confirm dialog for those actions; each surface supplies its own labels. */
export function DraftActionDialog({
  pending,
  busy,
  onClose,
  onConfirm,
  labels,
}: {
  pending: DraftAction | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Title doubles as the confirm-button label, matching both surfaces today. */
  labels: Record<DraftAction, { title: string; description: string }>;
}) {
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={pending ? labels[pending].title : ""}
      description={pending ? labels[pending].description : ""}
      confirmLabel={pending ? labels[pending].title : ""}
      variant={pending === "send" ? "default" : "destructive"}
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}
