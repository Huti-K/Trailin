import { clsx, type ClassValue } from "clsx";
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

/** The modifier the Cmd/Ctrl shortcuts listen for, spelled the way this keyboard prints it. */
export const MOD_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘" : "Ctrl";
