import log from "electron-log/main";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

/**
 * Outcome of a user-initiated check. "downloading" = a newer release exists and
 * is being fetched (completion arrives via the update-ready event).
 * "unsupported" = a dev run, no update feed baked into an unpackaged app.
 */
export type UpdateCheckStatus =
  | { status: "downloaded"; version: string }
  | { status: "downloading"; version: string }
  | { status: "current" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

let pending: string | null = null;

/**
 * electron-updater loads lazily: it only exists in a packaged app's
 * node_modules, and only packaged runs get here. Must load via CJS require (the
 * shell bundle's format): its `autoUpdater` is a getter on module.exports,
 * which `import()`'s named-export detection can't see.
 */
function loadUpdater(): typeof import("electron-updater") {
  return require("electron-updater") as typeof import("electron-updater");
}

export function pendingUpdateVersion(): string | null {
  return pending;
}

export function startUpdater(onDownloaded: (version: string) => void): void {
  const { autoUpdater } = loadUpdater();
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    pending = info.version;
    onDownloaded(info.version);
  });
  // Updating is best-effort: an unreachable feed or an unsigned build (macOS
  // refuses unsigned updates) can't take the app down.
  autoUpdater.on("error", (error) => log.warn(`updater: ${error.message}`));

  const check = () =>
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      log.warn(`updater check failed: ${String(error)}`);
    });
  void check();
  setInterval(check, CHECK_INTERVAL_MS);
}

export async function checkForUpdatesNow(): Promise<UpdateCheckStatus> {
  if (pending) return { status: "downloaded", version: pending };
  const { autoUpdater } = loadUpdater();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      return { status: "downloading", version: result.updateInfo.version };
    }
    return { status: "current" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`updater manual check failed: ${message}`);
    return { status: "error", message };
  }
}

export function installUpdate(): void {
  loadUpdater().autoUpdater.quitAndInstall();
}
