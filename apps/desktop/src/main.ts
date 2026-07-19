import { mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type UtilityProcess,
  utilityProcess,
  type WebContents,
} from "electron";
import log from "electron-log/main";
import { startNotifications, stopNotifications } from "./notifications";
import {
  checkForUpdatesNow,
  installUpdate,
  pendingUpdateVersion,
  startUpdater,
  type UpdateCheckStatus,
} from "./updater";

/**
 * First port tried, scanning upward when taken. Stable across launches so the
 * renderer origin (and with it localStorage: theme, panels, setup flag)
 * survives restarts.
 */
const BASE_PORT = 43117;
const PORT_SCAN_RANGE = 20;
const SERVER_READY_TIMEOUT_MS = 30_000;

let serverProcess: UtilityProcess | null = null;
let serverPort: number | null = null;
let quitting = false;

const smokeMode = Boolean(process.env.TRAILIN_DESKTOP_SMOKE);

/** Report a fatal error and leave; non-zero exit in smoke mode so a scripted run fails instead of hanging on a dialog. */
function fatal(message: string): void {
  log.error(message);
  if (smokeMode) {
    app.exit(1);
    return;
  }
  dialog.showErrorBox("Trailin", message);
  app.quit();
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = net.createServer();
    probe.once("error", () => resolveProbe(false));
    probe.once("listening", () => probe.close(() => resolveProbe(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function findFreePort(): Promise<number> {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_SCAN_RANGE; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free port in ${BASE_PORT}-${BASE_PORT + PORT_SCAN_RANGE - 1}`);
}

/** Filters out undefined values (which the utilityProcess API rejects); adds the loopback binding and data paths under Electron's userData. */
function serverEnv(port: number): Record<string, string> {
  const dataRoot = app.getPath("userData");
  mkdirSync(dataRoot, { recursive: true });
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return {
    ...merged,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: path.join(dataRoot, "data", "trailin.db"),
    // The agent home lives under userData like the DB, so it survives updates
    // (electron-updater replaces the app bundle, not userData). The old ~/Trailin
    // location migrates in via the default LEGACY_AGENT_HOME_PATH.
    AGENT_HOME_PATH: path.join(dataRoot, "agent-home"),
    // Pre-agent-home locations, still set so the server's boot migration can
    // move their contents into the agent home.
    LIBRARY_PATH: path.join(dataRoot, "library"),
    SKILLS_PATH: path.join(dataRoot, "skills"),
    WHATSAPP_AUTH_PATH: path.join(dataRoot, "data", "whatsapp-auth"),
    LOG_FILE: path.join(dataRoot, "logs", "trailin.log"),
    WEB_DIST_PATH: path.join(__dirname, "web"),
  };
}

function startServer(port: number): void {
  const entry = path.join(__dirname, "server", "index.mjs");
  const child = utilityProcess.fork(entry, [], {
    env: serverEnv(port),
    stdio: "inherit",
    serviceName: "trailin-server",
  });
  child.once("exit", (code) => {
    serverProcess = null;
    if (quitting) return;
    fatal(
      `The local Trailin server stopped unexpectedly (code ${code}). Check the logs and reopen the app.`,
    );
  });
  serverProcess = child;
}

function serverResponding(port: number): Promise<boolean> {
  return new Promise((resolvePoll) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1_000 }, (response) => {
      response.resume();
      resolvePoll(true);
    });
    request.on("error", () => resolvePoll(false));
    request.on("timeout", () => {
      request.destroy();
      resolvePoll(false);
    });
  });
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverProcess === null) throw new Error("server exited during startup");
    if (await serverResponding(port)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`server not reachable on port ${port} within ${SERVER_READY_TIMEOUT_MS}ms`);
}

/**
 * Route new-window requests to the user's browser, not an Electron child
 * window. The one exception: a popup from the embedded Pipedream Connect
 * iframe (the provider's OAuth window) stays in-app, since the iframe
 * holds its handle to detect completion. Applied recursively so links inside
 * that OAuth window also leave for the browser.
 */
function installLinkPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url, referrer }) => {
    if (referrer.url.startsWith("https://pipedream.com/")) return { action: "allow" };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    installLinkPolicy(child.webContents);
  });
}

function createWindow(port: number): void {
  const origin = `http://127.0.0.1:${port}`;
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#f4f4f5",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  installLinkPolicy(window.webContents);
  // The main window never leaves the local app: a stray in-window navigation to
  // an external origin opens in the browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    let external: boolean;
    try {
      external = new URL(url).origin !== origin;
    } catch {
      external = true;
    }
    if (!external) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  void window.loadURL(`${origin}/`);
  if (smokeMode) {
    window.webContents.once("did-finish-load", () => {
      log.info("desktop smoke: window loaded");
      app.quit();
    });
  }
}

function focusOrCreateWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  } else if (serverPort !== null) {
    createWindow(serverPort);
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // A second launch would race the first for the port and the SQLite file;
  // hand over to the running instance instead.
  app.quit();
} else {
  app.on("second-instance", () => {
    focusOrCreateWindow();
  });

  app.on("window-all-closed", () => {
    // On macOS the server (and its scheduled automations) keeps running with the
    // window closed; elsewhere closing quits.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort !== null) {
      createWindow(serverPort);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    stopNotifications();
    serverProcess?.kill();
  });

  ipcMain.handle("trailin:get-pending-update", () => pendingUpdateVersion());
  ipcMain.handle("trailin:get-app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }));
  ipcMain.handle("trailin:check-for-updates", (): Promise<UpdateCheckStatus> | UpdateCheckStatus =>
    app.isPackaged ? checkForUpdatesNow() : { status: "unsupported" },
  );
  ipcMain.on("trailin:install-update", () => installUpdate());

  void app.whenReady().then(async () => {
    try {
      const port = await findFreePort();
      serverPort = port;
      startServer(port);
      await waitForServer(port);
      createWindow(port);
      startNotifications(port, { onOpenRequest: focusOrCreateWindow });
      // Dev runs have no update feed baked in: app-update.yml only exists in a packaged build.
      if (app.isPackaged) {
        startUpdater((version) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send("trailin:update-ready", version);
          }
        });
      }
    } catch (error) {
      fatal(`Trailin failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
