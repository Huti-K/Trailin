import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

/** Colored status pill for an automation/activity run — the one status →
 *  variant mapping, shared by the Home activity feed and the Automations
 *  run list. */
export function RunStatusBadge({ status }: { status: "running" | "success" | "error" }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={status === "success" ? "success" : status === "error" ? "destructive" : "muted"}
    >
      {t(`automations.runStatus.${status}`)}
    </Badge>
  );
}
