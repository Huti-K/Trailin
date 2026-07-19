import { type ClassValue, clsx } from "clsx";
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

/** The modifier the Cmd/Ctrl shortcuts listen for, spelled the way this keyboard prints it. */
export const MOD_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";
