import type { ContactCategory } from "@trailin/shared";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Small pieces shared by the People and Newsletters lanes (ContactsPanel.tsx)
 * — kept here rather than duplicated in both, since neither lane is large
 * enough on its own to justify its own copy.
 */

/** Rows shown before a lane's list asks to be expanded, and how many each press adds. */
export const LANE_INITIAL_VISIBLE = 30;
export const LANE_VISIBLE_STEP = 60;

/** Below this a lane's search field is chrome — the whole list already fits on screen. */
export const LANE_SEARCH_THRESHOLD = 8;

/** Cap the cascade so a full page of rows doesn't take a second to finish arriving. */
export const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 45}ms` });

/** `contacts.category.<value>` — the one place a category enum value becomes display text. */
export function categoryLabel(
  t: ReturnType<typeof useTranslation>["t"],
  category: ContactCategory,
): string {
  return t(`contacts.category.${category}`);
}

/**
 * Neutral initial avatar for a contact or sender row. Contacts span
 * connected accounts, so — unlike AccountDot — no single account color
 * applies; a plain recessed circle with the name's first letter stands in.
 */
export function ContactAvatar({ label, className }: { label: string; className?: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-medium text-muted-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** Leading magnifier, trailing clear — the same shape used across the app's list filters. */
export function LaneSearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9 pr-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("common.clearSearch")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
