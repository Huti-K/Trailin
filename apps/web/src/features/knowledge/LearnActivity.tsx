import { useQuery } from "@tanstack/react-query";
import type { LearnRun } from "@trailin/shared";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { api } from "@/lib/api";
import { dayTimeLabel, relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * Learning activity: the draft-vs-sent loop's recent sweep runs, folded away
 * at the foot of the memory strip. Exists so "did the loop run, and did it
 * find anything" is answerable from the UI — most runs legitimately find
 * nothing to learn and would otherwise leave no visible trace anywhere.
 */
export function LearnActivity() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  // History is a bonus panel — a failed fetch just leaves it collapsed-empty.
  const { data: status } = useQuery({
    queryKey: ["learn", "status"],
    queryFn: () => api.learnStatus().catch(() => null),
  });

  if (!status) return null;

  const summary = (run: LearnRun): string => {
    if (run.status === "error") {
      return t("knowledge.sections.memory.learning.runFailed", { error: run.error ?? "" });
    }
    if (run.lessons > 0) {
      return t("knowledge.sections.memory.learning.runLessons", { count: run.lessons });
    }
    // Pairs the sweep resolved without a lesson: sent unchanged, or extracted
    // with nothing worth keeping.
    const checked = run.identical + run.learned;
    if (checked > 0) {
      return t("knowledge.sections.memory.learning.runNoChanges", { count: checked });
    }
    return t("knowledge.sections.memory.learning.runNothing");
  };

  return (
    <div className="flex flex-col gap-2">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)}>
        {t("knowledge.sections.memory.learning.toggle")}
      </DisclosureToggle>
      {open && (
        <div className="flex flex-col gap-2">
          <p className="max-w-prose text-pretty text-xs text-muted-foreground">
            {t("knowledge.sections.memory.learning.description")}
            {status.nextRunAt && (
              <>
                {" "}
                {t("knowledge.sections.memory.learning.nextRun", {
                  time: relativeTime(status.nextRunAt, i18n.language),
                })}
              </>
            )}
          </p>
          {status.runs.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">
              {t("knowledge.sections.memory.learning.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {status.runs.map((run) => (
                <li key={run.id} className="flex items-baseline gap-3">
                  <span
                    data-tooltip={new Date(run.startedAt).toLocaleString(i18n.language)}
                    className="w-24 shrink-0 font-mono tabular text-2xs text-muted-foreground/70"
                  >
                    {dayTimeLabel(run.startedAt, i18n.language)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      run.status === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {summary(run)}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground/60">
                    {run.reason === "boot"
                      ? t("knowledge.sections.memory.learning.reasonBoot")
                      : t("knowledge.sections.memory.learning.reasonScheduled")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
