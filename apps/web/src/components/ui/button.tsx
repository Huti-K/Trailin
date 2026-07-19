import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// Borderless buttons: brand-accent primary (the CTA), tonal fills for everything
// else. No strokes, no shadows. The only outline is the keyboard focus ring.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground hover:bg-accent/90",
        /* The confirm CTA in destructive dialogs (ConfirmDialog's default). */
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // "outline" in name only — a quiet tonal fill, no border.
        outline: "bg-surface-2 text-foreground hover:bg-secondary",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        /* Ghost for destructive row actions — pale red hover instead of the neutral fill. */
        "ghost-danger": "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
        "icon-xs": "h-7 w-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Disables the button and swaps its icon for a spinner; text children stay visible. */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        buttonVariants({ variant, size, className }),
        // The spinner below is the button's first child, so this hides only
        // the caller's own icon(s) for the duration.
        loading && "[&_svg:not(:first-child)]:hidden",
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
