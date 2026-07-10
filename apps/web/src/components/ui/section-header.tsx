import * as React from "react";

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
          <span className="tint-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5">
            {icon}
          </span>
        ) : (
          <span className="h-4 w-1 shrink-0 rounded-full bg-accent/50" />
        )}
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

/** A standard wrapper that groups a SectionHeader with its content. */
export function Section({
  title,
  description,
  children,
  className,
  index = 0,
  layout = "stack",
  icon,
  aside,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
  index?: number;
  layout?: "stack" | "row";
  icon?: React.ReactNode;
  /** Stack layout only: rendered beside the header (e.g. a status chip). */
  aside?: React.ReactNode;
}) {
  const header = <SectionHeader title={title} description={description} icon={icon} />;

  return (
    <section
      className={`relative flex flex-col gap-4 ${className || ""}`}
      style={{ animationDelay: `${index * 70}ms`, zIndex: 10 - index }}
    >
      {layout === "row" ? (
        <div className="flex items-center justify-between gap-4">
          {header}
          {children}
        </div>
      ) : (
        <>
          {aside ? (
            <div className="flex items-start justify-between gap-4">
              {header}
              {aside}
            </div>
          ) : (
            header
          )}
          {children}
        </>
      )}
    </section>
  );
}
