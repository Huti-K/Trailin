import { contextBridge, ipcRenderer } from "electron";
import type { UpdateCheckStatus } from "./updater";

/**
 * window.trailinDesktop — the web app's only view of the shell, kept to the
 * update flow. Mirrored by the DesktopBridge type in apps/web/src/lib/desktop.ts.
 */
contextBridge.exposeInMainWorld("trailinDesktop", {
  getAppInfo: (): Promise<{ version: string; platform: string; arch: string }> =>
    ipcRenderer.invoke("trailin:get-app-info") as Promise<{
      version: string;
      platform: string;
      arch: string;
    }>,
  getPendingUpdate: (): Promise<string | null> =>
    ipcRenderer.invoke("trailin:get-pending-update") as Promise<string | null>,
  checkForUpdates: (): Promise<UpdateCheckStatus> =>
    ipcRenderer.invoke("trailin:check-for-updates") as Promise<UpdateCheckStatus>,
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, version: string) => callback(version);
    ipcRenderer.on("trailin:update-ready", listener);
    return () => {
      ipcRenderer.removeListener("trailin:update-ready", listener);
    };
  },
  installUpdate: (): void => {
    ipcRenderer.send("trailin:install-update");
  },
});
