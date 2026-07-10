import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The shared elevated container. Wraps `.surface`/`.surface-soft`/`.surface-pop`
// (index.css) with a standard padding scale so call sites stop picking their own.
const cardVariants = cva("", {
  variants: {
    tone: {
      flat: "surface shadow-sm",
      soft: "surface-soft",
      /* The floating tier — what Select menus and popovers paint on. */
      pop: "surface-pop",
    },
    padding: {
      sm: "p-3",
      md: "p-4",
      lg: "p-5",
    },
  },
  defaultVariants: {
    tone: "flat",
    padding: "md",
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof cardVariants> {
  as?: React.ElementType;
}

export function Card({ className, tone, padding, as: Comp = "div", ...props }: CardProps) {
  return <Comp className={cn(cardVariants({ tone, padding }), className)} {...props} />;
}
