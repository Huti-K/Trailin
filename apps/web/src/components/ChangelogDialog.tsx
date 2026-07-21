import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CHANGELOG, changelogNotes } from "@/lib/changelog";
import { desktopBridge } from "@/lib/desktop";

/**
 * The version history as a plain list: version + date heading, then bullet
 * notes. When a downloaded update is waiting (`pendingVersion`), its entry wears
 * the accent "ready" badge and the footer offers the restart; the running
 * version (`currentVersion`) carries a quiet "installed" badge for orientation.
 */
export function ChangelogDialog({
  open,
  onOpenChange,
  pendingVersion,
  currentVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingVersion?: string | null;
  currentVersion?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("changelog.title")}
      description={t("changelog.subtitle")}
      footer={
        pendingVersion ? (
          <Button size="sm" onClick={() => desktopBridge()?.installUpdate()}>
            {t("app.updateRestart")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        {CHANGELOG.map((entry) => (
          <section key={entry.version} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold tracking-tight text-foreground">
                {t("changelog.version", { version: entry.version })}
              </h3>
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {formatDate(entry.date)}
              </span>
              {entry.version === pendingVersion ? (
                <Badge className="ml-auto">{t("changelog.ready")}</Badge>
              ) : (
                entry.version === currentVersion && (
                  <Badge variant="muted" className="ml-auto">
                    {t("changelog.current")}
                  </Badge>
                )
              )}
            </div>
            <ul className="flex flex-col gap-1.5">
              {changelogNotes(entry, i18n.language).map((note) => (
                <li key={note} className="flex gap-2.5 text-sm text-muted-foreground">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span className="min-w-0">{note}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
