import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SeenState } from "@trailin/shared";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { AccountDot } from "@/components/ui/account-dot";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "New since you last looked" for Home. An item is new when it was created
 * after the seen floor and carries no per-item mark; opening or acting on its
 * row clears the mark, as does the "seen all" action. The state is server-side
 * so it survives a reload and stays in step across windows.
 */
export interface Seen {
  isNew: (key: string, createdAt: string) => boolean;
  /** Mark one item seen; safe to call repeatedly. */
  see: (key: string) => void;
  seeAll: () => void;
}

/** Mark keys — one namespace per kind of Home item. */
export const todoSeenKey = (id: string) => `todo:${id}`;
export const outboundSeenKey = (id: string) => `outbound:${id}`;
export const runSeenKey = (id: string) => `run:${id}`;
export const draftSeenKey = (accountId: string, draftId: string) => `draft:${accountId}:${draftId}`;

export function useSeen(): Seen {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["seen"], queryFn: () => api.seen() });

  const mutation = useMutation({
    mutationFn: (input: string[] | "all") =>
      input === "all" ? api.markAllSeen() : api.markSeen(input),
    // The dot has to clear on the click, not on the round trip.
    onMutate: (input) => {
      queryClient.setQueryData<SeenState>(["seen"], (old) =>
        input === "all"
          ? { floor: new Date().toISOString(), keys: [] }
          : { floor: old?.floor ?? "", keys: [...(old?.keys ?? []), ...input] },
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["seen"] }),
  });

  const marked = React.useMemo(() => new Set(data?.keys ?? []), [data]);
  // Parsed, not string-compared: provider draft dates are not all ISO-Z, and an
  // unparsable date yields NaN, which reads as "not new" instead of always-new.
  const floorMs = data ? Date.parse(data.floor) : Number.NaN;

  return {
    isNew: (key, createdAt) => Date.parse(createdAt) > floorMs && !marked.has(key),
    see: (key) => mutation.mutate([key]),
    seeAll: () => mutation.mutate("all"),
  };
}

/**
 * Wraps one Home row: resolves whether it is new, hands that to the row for
 * its dot, and clears the mark as soon as the user clicks or keyboard-focuses
 * anything inside — no per-handler wiring in the rows themselves.
 */
export function SeenOnInteract({
  seen,
  itemKey,
  createdAt,
  className,
  style,
  children,
}: {
  seen: Seen;
  itemKey: string;
  createdAt: string;
  className?: string;
  /** Carries the caller's stagger delay, which must ride the animated element. */
  style?: React.CSSProperties;
  children: (isNew: boolean) => React.ReactNode;
}) {
  const isNew = seen.isNew(itemKey, createdAt);
  const see = isNew ? () => seen.see(itemKey) : undefined;
  return (
    <div className={className} style={style} onClickCapture={see} onFocusCapture={see}>
      {children(isNew)}
    </div>
  );
}

/** The "not looked at yet" marker: a small accent dot fronting a row's title. */
export function NewDot({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("home.newMark")}
      data-tooltip={t("home.newMark")}
      className={cn("flex shrink-0 items-center", className)}
    >
      <AccountDot tone="accent" className="dot-breathe h-2 w-2" />
    </span>
  );
}
