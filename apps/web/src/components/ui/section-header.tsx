import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { IconChip } from "@/components/ui/icon-chip";

/** Title + description pair shared by top-level section/step headers. */
export function SectionHeader({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  /** Replaces the accent bar with a 24px icon chip. */
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
        {icon ? (
          <IconChip size="sm">{icon}</IconChip>
        ) : (
          <span className="h-4 w-1 shrink-0 rounded-full bg-accent/50" />
        )}
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

/**
 * Page-section title row: icon tile, title, live count, optional collapse
 * toggle, a trailing slot for the section's own controls, and an optional
 * description line below. Every top-level list section (Home, Knowledge)
 * uses this one shape.
 */
export function SectionTitle({
  icon: Icon,
  tone = "tint-accent",
  title,
  count,
  description,
  expanded,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  /** Always a `tint-*` token, never a hand-mixed fill. */
  tone?: "tint-accent" | "tint-neutral" | "tint-success" | "tint-warning";
  title: string;
  /** `null` while the first fetch is in flight, so the badge doesn't flash a zero. */
  count?: number | null;
  /** The section's one-line blurb, rendered below the header row when given. */
  description?: string;
  expanded?: boolean;
  /** Makes the title row a collapse toggle with a trailing chevron. */
  onToggle?: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const badge = typeof count === "number" && count > 0 && (
    <Badge variant="muted" className="tabular">
      {/* Keyed on the value so a change remounts the span and replays the tick. */}
      <span key={count} className="count-tick inline-block">
        {count}
      </span>
    </Badge>
  );

  return (
    <>
      <div className="flex items-center gap-2.5">
        {onToggle ? (
          <h2 className="text-base font-semibold tracking-tight">
            <button
              type="button"
              onClick={onToggle}
              title={t(expanded ? "common.collapse" : "common.expand")}
              aria-expanded={expanded}
              className="flex select-none items-center gap-2.5 transition-colors hover:text-muted-foreground"
            >
              <IconChip tone={tone}>
                <Icon />
              </IconChip>
              {title}
              {badge}
              {expanded ? (
                <ChevronUp className="ml-1 h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="ml-1 h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </h2>
        ) : (
          <>
            <IconChip tone={tone}>
              <Icon />
            </IconChip>
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {badge}
          </>
        )}
        {children ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
        ) : null}
      </div>
      {description && (
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">{description}</p>
      )}
    </>
  );
}

/** A standard wrapper that groups a SectionHeader with its content. */
export function Section({
  title,
  description,
  children,
  className,
  index = 0,
  icon,
  aside,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
  index?: number;
  icon?: React.ReactNode;
  /** Rendered beside the header (e.g. a status chip). */
  aside?: React.ReactNode;
}) {
  const header = <SectionHeader title={title} description={description} icon={icon} />;

  return (
    <section
      className={`relative flex flex-col gap-4 ${className || ""}`}
      style={{ animationDelay: `${index * 70}ms`, zIndex: 10 - index }}
    >
      {aside ? (
        <div className="flex items-start justify-between gap-4">
          {header}
          {aside}
        </div>
      ) : (
        header
      )}
      {children}
    </section>
  );
}
