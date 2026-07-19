import { randomUUID } from "node:crypto";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type HtmlToTextOptions, htmlToText } from "html-to-text";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { emitServerEvent } from "../../core/events.js";
import { moduleLogger } from "../../core/logger.js";
import { errorMessage } from "../../core/utils/util.js";
import { knowledgeDir, resolveWithin } from "../home/agentHome.js";
import * as store from "./store.js";

const ingestLog = moduleLogger("library");

export const LIBRARY_EXTENSIONS = new Set([
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".docx",
  ".csv",
  ".html",
  ".htm",
]);
export const SUPPORTED_FORMATS = "PDF, Word (.docx), Markdown, text, CSV, HTML";

const libraryDir = knowledgeDir();

export function getLibraryDir(): string {
  return libraryDir;
}

/**
 * Resolve a document's stored relative path against the knowledge folder,
 * rejecting anything that escapes it (or names the folder itself): a DB row can't
 * point file access (read or delete) outside it.
 */
export function documentPath(relPath: string): string | null {
  const absPath = resolveWithin(libraryDir, relPath);
  return absPath === libraryDir ? null : absPath;
}

/** Documents are stored whole; this only guards against pathological files. */
const MAX_TEXT_LENGTH = 2_000_000;
const CHUNK_TARGET = 1800;
/** Files larger than this are listed as errors rather than read into memory. */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** A file modified this recently may still be mid-copy; give it a settle check. */
const QUIESCENCE_RECENT_MS = 5000;
const QUIESCENCE_WAIT_MS = 500;
const QUIESCENCE_RESCAN_MS = 2000;

/** html-to-text options: headings stay as written (uppercased by default), links keep their URLs so they stay searchable. */
const HTML_EXTRACT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
    selector,
    options: { uppercase: false },
  })),
};

async function extractText(absPath: string, ext: string): Promise<string> {
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(await readFile(absPath)) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: await readFile(absPath) });
    return value;
  }
  if (ext === ".html" || ext === ".htm") {
    return htmlToText(await readFile(absPath, "utf8"), HTML_EXTRACT_OPTIONS).trim();
  }
  return readFile(absPath, "utf8");
}

function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips NUL bytes from extracted document text before storage/indexing
      .replace(/\u0000/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_TEXT_LENGTH)
  );
}

/**
 * Split into contiguous slices of ~CHUNK_TARGET characters, breaking at a
 * paragraph, line or sentence boundary. Slices are exact (no trimming), so
 * joining them restores the text.
 */
function chunkText(text: string, target = CHUNK_TARGET): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + target, text.length);
    if (end < text.length) {
      const windowStart = pos + Math.floor(target / 2);
      const window = text.slice(windowStart, end);
      for (const boundary of ["\n\n", "\n", ". "]) {
        const at = window.lastIndexOf(boundary);
        if (at !== -1) {
          end = windowStart + at + boundary.length;
          break;
        }
      }
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

async function listFiles(): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const found = new Map<string, { size: number; mtimeMs: number }>();
  const visit = async (rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(libraryDir, rel), { withFileTypes: true });
    } catch (error) {
      // A permission-denied or vanished subfolder doesn't abort the whole scan;
      // skip this subtree.
      ingestLog.warn({ err: error, rel }, "skipping unreadable library directory");
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(relPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(join(libraryDir, relPath));
          found.set(relPath, { size: info.size, mtimeMs: Math.round(info.mtimeMs) });
        } catch {
          // Vanished between readdir and stat; the follow-up scan reconciles it away.
        }
      }
    }
  };
  await visit("");
  return found;
}

async function indexFile(relPath: string, size: number, mtimeMs: number): Promise<boolean> {
  const ext = extname(relPath).toLowerCase();
  const base = {
    path: relPath,
    title: basename(relPath, extname(relPath)),
    ext: ext.slice(1),
    size,
    mtimeMs,
  };
  // Unsupported and oversized files still get a visible row: no extraction or
  // chunking, so a stray spreadsheet or image is never read.
  if (size > MAX_FILE_SIZE) {
    store.replaceDocument(
      { ...base, status: "error", error: "file too large to index", textLength: 0 },
      [],
    );
    return false;
  }
  if (!LIBRARY_EXTENSIONS.has(ext)) {
    store.replaceDocument(
      {
        ...base,
        status: "error",
        error: `unsupported file format — supported: ${SUPPORTED_FORMATS}`,
        textLength: 0,
      },
      [],
    );
    return false;
  }
  try {
    const text = normalize(await extractText(join(libraryDir, relPath), ext));
    if (!text) {
      store.replaceDocument(
        {
          ...base,
          status: "error",
          error: "no readable text in this file — a scanned PDF has no text layer",
          textLength: 0,
        },
        [],
      );
      return false;
    }
    store.replaceDocument(
      { ...base, status: "indexed", error: null, textLength: text.length },
      chunkText(text),
    );
    return true;
  } catch (error) {
    store.replaceDocument(
      { ...base, status: "error", error: errorMessage(error), textLength: 0 },
      [],
    );
    return false;
  }
}

interface ScanSummary {
  indexed: number;
  failed: number;
  removed: number;
}

let scanning: Promise<ScanSummary> | null = null;
let rescanWanted = false;

/** Reconcile the folder with the index. Concurrent calls share one scan. */
function scanLibrary(): Promise<ScanSummary> {
  if (scanning) {
    rescanWanted = true;
    return scanning;
  }
  scanning = doScan().finally(() => {
    scanning = null;
    if (rescanWanted) {
      rescanWanted = false;
      scanLibrary().catch((error: unknown) =>
        ingestLog.error({ err: error }, "chained library rescan failed"),
      );
    }
  });
  return scanning;
}

/** Two stats ~500ms apart: true while the file is still being written to. */
async function isStillChanging(relPath: string): Promise<boolean> {
  const absPath = join(libraryDir, relPath);
  try {
    const before = await stat(absPath);
    await sleep(QUIESCENCE_WAIT_MS);
    const after = await stat(absPath);
    return after.size !== before.size || after.mtimeMs !== before.mtimeMs;
  } catch {
    // Vanished mid-check; the follow-up scan reconciles it away.
    return true;
  }
}

async function doScan(): Promise<ScanSummary> {
  await mkdir(libraryDir, { recursive: true });
  const files = await listFiles();
  const documents = await store.listDocuments();
  const summary: ScanSummary = { indexed: 0, failed: 0, removed: 0 };

  for (const doc of documents) {
    if (!files.has(doc.path)) {
      store.removeDocument(doc.id);
      summary.removed += 1;
    }
  }

  const byPath = new Map(documents.map((d) => [d.path, d]));
  let settling = false;
  for (const [relPath, info] of files) {
    const known = byPath.get(relPath);
    const unchanged =
      known &&
      known.size === info.size &&
      known.modifiedAt === new Date(info.mtimeMs).toISOString();
    if (unchanged) continue;
    // A just-modified file may still be copying in. If it's visibly growing,
    // skip it this round (no error row for a half-written file); the follow-up
    // scan indexes it once the copy settles.
    if (Date.now() - info.mtimeMs < QUIESCENCE_RECENT_MS && (await isStillChanging(relPath))) {
      settling = true;
      continue;
    }
    // Serial on purpose: one PDF at a time, so a full folder never spikes CPU
    // under a running chat.
    if (await indexFile(relPath, info.size, info.mtimeMs)) summary.indexed += 1;
    else summary.failed += 1;
  }
  if (settling) scheduleScan(QUIESCENCE_RESCAN_MS);
  if (summary.indexed || summary.failed || summary.removed) emitServerEvent("library");
  return summary;
}

let watcher: FSWatcher | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let watcherRetryTimer: NodeJS.Timeout | null = null;
/** Bumped every time stopWatcher() tears a watcher down. A delayed retry
 *  captures the generation live when armed and checks it before resurrecting a
 *  watcher, so it never fires for a watcher already re-armed by another attempt. */
let watcherGeneration = 0;
const WATCHER_RETRY_MS = 30_000;

function scheduleScan(delayMs: number): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanLibrary().catch((error: unknown) =>
      ingestLog.error({ err: error }, "scheduled library scan failed"),
    );
  }, delayMs);
}

function stopWatcher(): void {
  watcher?.close();
  watcher = null;
  watcherGeneration += 1;
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  // Drop a pending watcher-restart retry: it belongs to the watcher just closed.
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}

function startWatcher(): void {
  stopWatcher();
  const generation = watcherGeneration;
  try {
    const instance = watch(libraryDir, { recursive: true }, () => scheduleScan(1000));
    watcher = instance;
    instance.on("error", (error) => {
      // A stray event from a watcher already superseded by an earlier retry;
      // this generation is no longer current, nothing to close or retry.
      if (watcherGeneration !== generation) return;
      ingestLog.warn(
        { err: error, folder: libraryDir },
        `library watcher failed — retrying in ${WATCHER_RETRY_MS / 1000}s`,
      );
      instance.close();
      watcher = null;
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        // Stale by the time the backoff elapsed (already re-armed some other
        // way). Re-arming here would resurrect a watcher nobody wants.
        if (watcherGeneration !== generation) return;
        startWatcher();
      }, WATCHER_RETRY_MS);
    });
  } catch {
    // No folder watching on this platform; boot scans and the UI's rescan still work.
  }
}

export async function startLibrary(log: (message: string) => void): Promise<void> {
  await mkdir(libraryDir, { recursive: true });
  scanLibrary()
    .then((s) => {
      if (s.indexed || s.failed || s.removed) {
        log(`Library scan: ${s.indexed} indexed, ${s.removed} removed, ${s.failed} failed`);
      }
    })
    .catch((error: unknown) => ingestLog.error({ err: error }, "initial library scan failed"));
  startWatcher();
}

export function stopLibrary(): void {
  stopWatcher();
}

/**
 * Write `data` into the library (or subfolder `relDir`) under a hidden temp
 * name, then rename to `name`: the scanner skips dotfiles, so a partially
 * written file is never visible to it. Cleans up on failure, rescans on
 * success. Returns the path relative to the library root.
 */
async function writeIntoLibrary(
  relDir: string,
  name: string,
  tempPrefix: string,
  data: string | Buffer,
): Promise<string> {
  const dir = relDir ? join(libraryDir, relDir) : libraryDir;
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${tempPrefix}-${randomUUID()}`);
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, join(dir, name));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await scanLibrary();
  return relDir ? `${relDir}/${name}` : name;
}

export async function saveUpload(fileName: string, data: Buffer, relDir = ""): Promise<string> {
  const name = basename(fileName.trim());
  if (!name || name.startsWith(".")) throw new Error("invalid file name");
  if (!LIBRARY_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new Error(`unsupported file type — use ${[...LIBRARY_EXTENSIONS].join(", ")}`);
  }
  if (relDir && !resolveWithin(libraryDir, relDir)) throw new Error("invalid target folder");
  return writeIntoLibrary(relDir, name, "upload", data);
}

/** Every directory under the knowledge folder as relative paths, empty ones included. */
export async function listFolders(): Promise<string[]> {
  const found: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(libraryDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      found.push(relPath);
      await visit(relPath);
    }
  };
  await visit("");
  return found.sort();
}

/** Create a (possibly nested) folder inside the knowledge folder. */
export async function createFolder(relPath: string): Promise<boolean> {
  const absPath = documentPath(relPath);
  if (!absPath) return false;
  await mkdir(absPath, { recursive: true });
  emitServerEvent("library");
  return true;
}

/**
 * Delete a folder and everything in it. Confined like every file op, and it
 * must really be a directory — a document id or file path must never slip
 * through to a recursive rm. The rescan drops the removed files' index rows.
 */
export async function deleteFolder(relPath: string): Promise<boolean> {
  const absPath = documentPath(relPath);
  if (!absPath) return false;
  const info = await stat(absPath).catch(() => null);
  if (!info?.isDirectory()) return false;
  await rm(absPath, { recursive: true, force: true });
  await scanLibrary();
  emitServerEvent("library");
  return true;
}

/** Extensions whose raw text the web editor may read and write back. */
const EDITABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);
/** Editor cap: a text file past this is data, not a note someone hand-edits. */
const MAX_EDITABLE_SIZE = 1024 * 1024;

/** A document's raw file text for editing; null when missing or not an editable text file. */
export async function readDocumentText(id: string): Promise<string | null> {
  const doc = await store.getDocument(id);
  if (!doc || !EDITABLE_EXTENSIONS.has(doc.ext) || doc.size > MAX_EDITABLE_SIZE) return null;
  const absPath = documentPath(doc.path);
  if (!absPath) return null;
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Overwrite an editable document's file in place (same path, temp+rename, rescan). */
export async function writeDocumentText(id: string, content: string): Promise<boolean> {
  const doc = await store.getDocument(id);
  if (!doc || !EDITABLE_EXTENSIONS.has(doc.ext)) return false;
  if (!documentPath(doc.path)) return false;
  const slash = doc.path.lastIndexOf("/");
  await writeIntoLibrary(
    slash === -1 ? "" : doc.path.slice(0, slash),
    slash === -1 ? doc.path : doc.path.slice(slash + 1),
    "edit",
    content,
  );
  return true;
}

/**
 * Delete a document's file and index row. The file is removed only when its
 * stored path resolves inside the knowledge folder (documentPath): a traversal
 * path can't delete outside it, though the index row is dropped either way.
 */
export async function deleteDocument(id: string): Promise<boolean> {
  const doc = await store.getDocument(id);
  if (!doc) return false;
  const absPath = documentPath(doc.path);
  if (absPath) await rm(absPath, { force: true });
  store.removeDocument(id);
  emitServerEvent("library");
  return true;
}
