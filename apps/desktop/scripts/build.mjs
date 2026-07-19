#!/usr/bin/env node
/**
 * Assembles the runnable desktop app in build/app:
 *
 *   main.cjs / preload.cjs  – the Electron shell (src/, bundled)
 *   server/index.mjs        – the @trailin/server bundle: first-party code
 *                             (including @trailin/shared) only — every npm
 *                             dependency stays external and is installed as a
 *                             real package, so native modules (better-sqlite3)
 *                             and worker-thread loaders (pino transports) work
 *                             exactly as in a plain Node install
 *   web/                    – the built @trailin/web app, copied verbatim
 *   package.json            – generated: exact-pinned runtime deps for
 *                             `npm install` + electron-builder's native rebuild
 *
 * `npm install --prefix build/app --omit=dev` (see the dev/dist scripts)
 * populates node_modules; electron-builder then rebuilds native modules
 * against Electron's ABI when packaging.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const outDir = path.join(desktopRoot, "build", "app");
const webDist = path.join(repoRoot, "apps", "web", "dist");

if (!existsSync(path.join(webDist, "index.html"))) {
  console.error("apps/web/dist is missing — run `pnpm --filter @trailin/web build` first.");
  process.exit(1);
}

/** Exact installed versions of a workspace package's prod dependencies. */
function installedDependencies(filter) {
  const raw = execSync(`pnpm --filter ${filter} list --prod --depth 0 --json`, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const [project] = JSON.parse(raw);
  return Object.fromEntries(
    Object.entries(project?.dependencies ?? {}).map(([name, info]) => [name, info.version]),
  );
}

const serverDeps = installedDependencies("@trailin/server");
const desktopDeps = installedDependencies("@trailin/desktop");

// Not shipped: @trailin/shared is bundled into server/index.mjs, tsx only
// runs the TypeScript sources in dev.
const EXCLUDED = new Set(["@trailin/shared", "tsx"]);

const runtimeDeps = Object.fromEntries(
  [
    ...Object.entries(serverDeps).filter(([name]) => !EXCLUDED.has(name)),
    ["electron-updater", desktopDeps["electron-updater"]],
  ].sort(([a], [b]) => a.localeCompare(b)),
);

// Replace previous bundles but keep node_modules/package-lock.json, so the
// follow-up `npm install` stays incremental.
for (const stale of ["main.cjs", "preload.cjs", "server", "web", "package.json"]) {
  rmSync(path.join(outDir, stale), { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const desktopPkg = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const appPkg = {
  name: "trailin",
  productName: "Trailin",
  version: desktopPkg.version,
  private: true,
  description: "Local-first AI email agent",
  author: "Trailin",
  main: "main.cjs",
  dependencies: runtimeDeps,
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(appPkg, null, 2)}\n`);

// The shell. electron is provided by the runtime; electron-updater is a real
// package in the app's node_modules (and is only loaded when packaged).
await build({
  entryPoints: [
    path.join(desktopRoot, "src", "main.ts"),
    path.join(desktopRoot, "src", "preload.ts"),
  ],
  outdir: outDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater"],
  logLevel: "warning",
});

// The server. ESM to match apps/server ("type": "module"); externals resolve
// from the app's node_modules at runtime.
await build({
  entryPoints: [path.join(repoRoot, "apps", "server", "src", "index.ts")],
  outfile: path.join(outDir, "server", "bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(serverDeps).filter((name) => name !== "@trailin/shared"),
  logLevel: "warning",
});

// The server reads its prompt texts at runtime from prompts/ beside the
// bundle (see apps/server/src/agent/prompts.ts).
cpSync(
  path.join(repoRoot, "apps", "server", "src", "agent", "prompts"),
  path.join(outDir, "server", "prompts"),
  { recursive: true },
);

// Default automation instructions, read at runtime from instructions/ beside
// the bundle (see apps/server/src/automations/defaults.ts).
cpSync(
  path.join(repoRoot, "apps", "server", "src", "automations", "instructions"),
  path.join(outDir, "server", "instructions"),
  { recursive: true },
);

// Entry the shell forks. pdfjs (via pdf-parse) treats any Electron-flavored
// process as a browser and touches DOM globals at import time, so the
// Electron markers are hidden before the bundle loads — the dynamic import
// is what defers the bundle's (hoisted) imports until after the patch.
// The server is plain Node code; nothing in it reads these markers.
writeFileSync(
  path.join(outDir, "server", "index.mjs"),
  [
    "// Generated by scripts/build.mjs — see the server bundle build step.",
    "for (const patch of [",
    "  () => delete process.versions.electron,",
    "  () => delete process.type,",
    "]) {",
    "  try {",
    "    patch();",
    "  } catch {}",
    "}",
    'await import("./bundle.mjs");',
    "",
  ].join("\n"),
);

cpSync(webDist, path.join(outDir, "web"), { recursive: true });

console.log(
  `assembled ${path.relative(repoRoot, outDir)} (v${appPkg.version}, ${Object.keys(runtimeDeps).length} runtime deps)`,
);
