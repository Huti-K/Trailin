import {
  app,
  type BrowserWindowConstructorOptions,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
} from "electron";
import { titleBarMode } from "./titlebar";

// Native window-background tone shown before the renderer paints and along the
// window edge while resizing. Mirrors the web palette's --sidebar so a dark
// launch doesn't flash white; kept in sync by hand (only the pre-paint flash
// rides on it — the visible chrome is the web sidebar itself).
const CHROME_LIGHT = "#ffffff";
const CHROME_DARK = "#0b0b0d";

export function chromeBackground(dark: boolean): string {
  return dark ? CHROME_DARK : CHROME_LIGHT;
}

export function initialBackground(): string {
  return chromeBackground(nativeTheme.shouldUseDarkColors);
}

/**
 * Data-URL progress page shown in the window while the local server boots.
 * Inline so it needs no packaged asset.
 *
 * The bar is time-driven, not measured: the server spends its startup inside
 * the module graph, before any of its own code could report a phase, so there
 * is nothing real to sample. It eases toward a ceiling it never reaches, so it
 * always moves and never reads as finished early; the window navigating to the
 * app is what ends it. The notes carry the actual information, and only appear
 * once a wait is long enough to need explaining.
 */
export function splashUrl(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const track = dark ? "#27272a" : "#e4e4e7";
  const fill = dark ? "#a1a1aa" : "#52525b";
  const notes = [
    [8_000, "Der lokale Server startet."],
    [
      25_000,
      "Beim ersten Start nach einer Installation oder einem Update prüft das Betriebssystem alle Dateien der App. Das dauert einmalig länger.",
    ],
    [
      60_000,
      "Das dauert ungewöhnlich lange. Trailin protokolliert den Start in logs/trailin.log im Datenordner.",
    ],
  ] as const;
  const html =
    `<!doctype html><title>Trailin</title><style>` +
    `html,body{height:100%;margin:0;background:${chromeBackground(dark)}}` +
    `body{display:flex;align-items:center;justify-content:center;color:${fill};` +
    `font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}` +
    `main{width:264px;text-align:center}` +
    `#t{height:2px;border-radius:1px;background:${track};overflow:hidden}` +
    `#f{height:100%;width:0;background:${fill}}` +
    `p{margin:14px 0 0}#n{margin-top:6px;font-size:12px;opacity:.65}` +
    `</style><main><div id="t"><div id="f"></div></div>` +
    `<p>Trailin wird gestartet</p><p id="n"></p></main><script>` +
    `var p=0,s=Date.now(),n=${JSON.stringify(notes)};` +
    `setInterval(function(){` +
    `p+=(92-p)*0.06;document.getElementById("f").style.width=p.toFixed(1)+"%";` +
    `var e=Date.now()-s,m="";for(var i=0;i<n.length;i++){if(e>=n[i][0])m=n[i][1]}` +
    `var d=document.getElementById("n");if(d.textContent!==m)d.textContent=m;` +
    `},80)</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** macOS drops the title bar and lets the web chrome run edge to edge under the
 *  floating traffic lights; other platforms keep their native bar. */
export function windowChrome(): BrowserWindowConstructorOptions {
  if (titleBarMode() === "inset") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } };
  }
  return {};
}

/** macOS keeps a minimal native menu — the app/edit/window roles that the
 *  standard shortcuts (copy, paste, quit) are wired through — minus the
 *  File/Help clutter. Elsewhere the menu bar is dropped entirely; Chromium still
 *  handles the edit shortcuts inside the web content. */
export function installAppMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const view: MenuItemConstructorOptions[] = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (!app.isPackaged) {
    view.unshift(
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
    );
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { label: "View", submenu: view },
      { role: "windowMenu" },
    ]),
  );
}
