import { Sparkles } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChangelogDialog } from "@/components/ChangelogDialog";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/* DEV showcase override — delete with the /showcase route. The sidebar fills
 * only from the desktop bridge, so outside the shell there is no way to see
 * the pill in place; this lets the showcase stand one up in the real sidebar. */
let showcaseVersion: string | null = null;
const showcaseListeners = new Set<() => void>();

export function setShowcaseUpdate(version: string | null) {
  showcaseVersion = version;
  for (const notify of showcaseListeners) notify();
}

function subscribeShowcase(onChange: () => void) {
  showcaseListeners.add(onChange);
  return () => {
    showcaseListeners.delete(onChange);
  };
}

/**
 * The version downloaded and waiting for a restart, or null. Desktop shell
 * only: without a bridge (the browser, the dev server) it stays null.
 */
export function usePendingUpdate() {
  const [version, setVersion] = React.useState<string | null>(null);
  const showcase = React.useSyncExternalStore(subscribeShowcase, () => showcaseVersion);

  React.useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    void bridge.getPendingUpdate().then((pending) => {
      if (pending) setVersion(pending);
    });
    return bridge.onUpdateReady(setVersion);
  }, []);

  return showcase ?? version;
}

/**
 * Sidebar footer CTA for an update that is waiting for a restart. It opens the
 * changelog, where the new version's notes sit above the restart CTA. Collapses
 * to its icon with the sidebar, on the same md breakpoint as the nav links.
 */
export function UpdatePill({ version, isCollapsed }: { version: string; isCollapsed: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const label = t("app.updateAvailable");

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className={cn(
          "animate-in-up update-pill w-full shrink-0 px-3",
          isCollapsed && "md:w-9 md:px-0",
        )}
        aria-label={label}
        data-tooltip={isCollapsed ? label : undefined}
      >
        <Sparkles />
        <span className={cn(isCollapsed && "md:hidden")}>{label}</span>
      </Button>
      <ChangelogDialog open={open} onOpenChange={setOpen} pendingVersion={version} />
    </>
  );
}
