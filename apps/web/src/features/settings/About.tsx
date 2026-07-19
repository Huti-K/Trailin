import { Check, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LinkButton } from "@/components/ui/link-button";
import { ListRow } from "@/components/ui/list-row";
import { Spinner } from "@/components/ui/spinner";
import { type DesktopAppInfo, desktopBridge, type UpdateCheckStatus } from "@/lib/desktop";
import { cn, openExternal } from "@/lib/utils";

const REPO_SLUG = "Huti-K/Trailin";
const REPO_URL = `https://github.com/${REPO_SLUG}`;
const ISSUES_URL = `${REPO_URL}/issues`;
/** Mirrors appId in apps/desktop/electron-builder.yml. */
const BUNDLE_ID = "app.trailin.desktop";

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: UpdateCheckStatus };

/**
 * Settings → About: one card with the app identity (logo, tagline, version),
 * a key-value list of build facts, and the update/GitHub actions. A manual
 * check rides the shell's auto-download pipeline — a found update downloads
 * in the background and the action flips to "restart" (like the global toast)
 * when the shell reports it ready. In a plain browser tab there is no shell,
 * so the build row and update action are omitted.
 */
export function AboutPanel() {
  const { t } = useTranslation();
  const bridge = desktopBridge();
  const [info, setInfo] = React.useState<DesktopAppInfo | null>(null);
  const [check, setCheck] = React.useState<CheckState>({ phase: "idle" });

  React.useEffect(() => {
    const shell = desktopBridge();
    if (!shell) return;
    const showReady = (ready: string) =>
      setCheck({ phase: "done", result: { status: "downloaded", version: ready } });
    shell.getAppInfo().then(setInfo, () => {});
    void shell.getPendingUpdate().then((pending) => {
      if (pending) showReady(pending);
    });
    return shell.onUpdateReady(showReady);
  }, []);

  const runCheck = async () => {
    const shell = desktopBridge();
    if (!shell) return;
    setCheck({ phase: "checking" });
    const result = await shell
      .checkForUpdates()
      .catch((): UpdateCheckStatus => ({ status: "error", message: "" }));
    setCheck({ phase: "done", result });
  };

  const result = check.phase === "done" ? check.result : null;
  const readyVersion = result?.status === "downloaded" ? result.version : null;
  const platform = info ? (PLATFORM_LABELS[info.platform] ?? info.platform) : null;

  return (
    <ListRow className="flex-col items-stretch gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/logo.svg" alt="" className="h-9 w-9 shrink-0 object-contain" />
          <div className="min-w-0">
            <Label className="text-sm font-medium">Trailin</Label>
            <p className="text-xs text-muted-foreground">{t("settings.about.tagline")}</p>
          </div>
        </div>
        {info && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            v{info.version}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {info && (
          <MetaRow label={t("settings.about.build")} mono>
            {platform} · {info.arch} · v{info.version}
          </MetaRow>
        )}
        <MetaRow label={t("settings.about.bundleId")} mono>
          {BUNDLE_ID}
        </MetaRow>
        <MetaRow label={t("settings.about.license")}>{t("settings.about.licenseValue")}</MetaRow>
        <MetaRow label={t("settings.about.source")}>
          <LinkButton
            onClick={() => openExternal(REPO_URL)}
            className="flex items-center gap-1.5 font-mono text-foreground"
          >
            <GithubMark className="h-3.5 w-3.5" />
            {REPO_SLUG}
          </LinkButton>
        </MetaRow>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <LinkButton onClick={() => openExternal(ISSUES_URL)}>
            {t("settings.about.reportIssue")}
          </LinkButton>
          <Button variant="secondary" size="sm" onClick={() => openExternal(REPO_URL)}>
            <GithubMark />
            {t("settings.about.viewOnGithub")}
          </Button>
          {bridge &&
            (readyVersion ? (
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => desktopBridge()?.installUpdate()}
              >
                {t("app.updateRestart")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                loading={check.phase === "checking"}
                onClick={() => void runCheck()}
              >
                <RefreshCw />
                {t("settings.about.check")}
              </Button>
            ))}
        </div>
        {bridge && (
          <div className="flex h-4 items-center justify-end gap-1.5 text-xs text-muted-foreground">
            <CheckOutcome result={result} readyVersion={readyVersion} />
          </div>
        )}
      </div>
    </ListRow>
  );
}

/** One fact in the technical-details list: quiet label left, value right. */
function MetaRow({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <span className={cn("min-w-0 truncate text-foreground", mono && "font-mono tabular-nums")}>
        {children}
      </span>
    </div>
  );
}

/** Quiet feedback under the identity row once a check resolves. */
function CheckOutcome({
  result,
  readyVersion,
}: {
  result: UpdateCheckStatus | null;
  readyVersion: string | null;
}) {
  const { t } = useTranslation();
  if (!result) return null;

  if (readyVersion) {
    return <span>{t("settings.about.downloaded", { version: readyVersion })}</span>;
  }
  switch (result.status) {
    case "downloading":
      return (
        <>
          <Spinner className="h-3.5 w-3.5" />
          <span>{t("settings.about.downloading", { version: result.version })}</span>
        </>
      );
    case "current":
      return (
        <>
          <Check className="h-3.5 w-3.5 text-success" />
          <span>{t("settings.about.upToDate")}</span>
        </>
      );
    case "unsupported":
      return <span>{t("settings.about.unavailable")}</span>;
    case "error":
      return <span className="text-destructive">{t("settings.about.checkFailed")}</span>;
    default:
      return null;
  }
}

/** The GitHub mark — lucide ships no brand icons, so the path is inlined. */
function GithubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.67.41.36.78 1.06.78 2.14 0 1.54-.02 2.79-.02 3.17 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
