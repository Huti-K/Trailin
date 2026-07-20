import { type ClassValue, clsx } from "clsx";
import { flushSync } from "react-dom";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one grey every account dot, chip, and the ColorPicker fall back to for an
 * account with no color assigned. A literal hex (not a theme token) because it
 * must read as "no color chosen" in both themes and seed the hex color picker.
 */
export const UNASSIGNED_ACCOUNT_COLOR = "#616161";

/** Open a URL in a new tab without handing the opener window to the target. */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Spread-props that make a non-button row behave as an expand/collapse toggle
 * (role, Enter/Space activation, aria-expanded) — for header rows that contain
 * real buttons and therefore can't be a native <button> themselves.
 */
export function toggleRowProps(expanded: boolean, onToggle: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: onToggle,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle();
      }
    },
  };
}

/** Sort key landing between two neighbors' keys; an open end steps past the one that exists. */
export function midpoint(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return Date.now();
  if (a === undefined) return (b as number) - 1;
  if (b === undefined) return a + 1;
  return (a + b) / 2;
}

/** List-entrance stagger, capped so a full page of rows doesn't take a second to finish arriving. */
export const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 45}ms` });

/**
 * Marks a row as its own view-transition subject, so it slides to its new
 * position when the list around it changes instead of being cross-faded as
 * part of the page. The id must be unique on screen and start with a letter —
 * a bare uuid is not a valid CSS ident.
 */
export const rowTransition = (id: string) => ({ viewTransitionName: `row-${CSS.escape(id)}` });

/**
 * Applies a list mutation inside a view transition. `mutate` must change the
 * DOM synchronously — a direct state write or `setQueryData` — because the
 * transition captures the "after" frame as soon as it returns; an async
 * refetch would land too late and animate nothing. Falls back to a plain call
 * where the API is missing or the user asked for reduced motion.
 */
export function withViewTransition(mutate: () => void): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof document.startViewTransition !== "function") {
    mutate();
    return;
  }
  document.startViewTransition(() => {
    flushSync(mutate);
  });
}

/** The modifier the Cmd/Ctrl shortcuts listen for, spelled the way this keyboard prints it. */
export const MOD_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";
