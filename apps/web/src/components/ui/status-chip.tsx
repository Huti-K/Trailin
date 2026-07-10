import * as React from "react";
import { cn } from "@/lib/utils";

const TONE = {
  success: "tint-success",
  warning: "tint-warning",
  muted: "tint-neutral",
} as const;

/** Small pill for a section header's status — icons are sized here, callers don't need to. */
export function StatusChip({
  tone,
  icon,
  children,
}: {
  tone: keyof typeof TONE;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium [&_svg]:h-3.5 [&_svg]:w-3.5",
        TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}
