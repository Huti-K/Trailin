import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { LibraryDocumentContent, LibrarySearchHit, LibraryStatus } from "@trailin/shared";
import { badRequest, notFound } from "../core/errors.js";
import { moduleLogger } from "../core/logger.js";
import { contentDisposition, inlineForMime, mimeForExt } from "../core/utils/fileResponse.js";
import { errorMessage } from "../core/utils/util.js";
import { trimSnippet } from "../services/search/snippets.js";
import { getAgentHomeDir, resolveWithin } from "../storage/home/agentHome.js";
import {
  createFolder,
  deleteDocument,
  deleteFolder,
  getLibraryDir,
  listFolders,
  readDocumentText,
  saveUpload,
  writeDocumentText,
} from "../storage/library/ingest.js";
import {
  getDocument,
  listDocuments,
  type SearchHit,
  searchChunks,
} from "../storage/library/store.js";

const log = moduleLogger("library");

const UPLOAD_LIMIT = 64 * 1024 * 1024;

/** Show a folder in the OS file manager; fire-and-forget (single-user, same machine). */
function openInFileManager(absPath: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [absPath]]
      : process.platform === "win32"
        ? ["explorer", [absPath]]
        : ["xdg-open", [absPath]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", (err) => log.warn({ err, absPath }, "opening folder in file manager failed"));
  child.unref();
}

// Over-fetch chunks so collapsing to one hit per document still yields ~SEARCH_DOC_LIMIT documents.
const SEARCH_DOC_LIMIT = 20;
const SEARCH_CHUNK_LIMIT = 80;

function searchDocuments(q: string): LibrarySearchHit[] {
  let hits: SearchHit[];
  try {
    hits = searchChunks(q, SEARCH_CHUNK_LIMIT);
  } catch {
    // FTS5 can still reject input despite buildMatch quoting; retry sanitized rather than 500.
    try {
      hits = searchChunks(q.replace(/[^\p{L}\p{N}\s]/gu, " "), SEARCH_CHUNK_LIMIT);
    } catch {
      hits = [];
    }
  }

  const seen = new Set<string>();
  const results: LibrarySearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.documentId)) continue;
    seen.add(hit.documentId);
    results.push({
      id: hit.documentId,
      title: hit.title,
      path: hit.path,
      ext: hit.ext,
      snippet: trimSnippet(hit.snippet),
    });
    if (results.length >= SEARCH_DOC_LIMIT) break;
  }
  return results;
}

const librarySearchQuery = Type.Object({ q: Type.Optional(Type.String()) });
const libraryFilesQuery = Type.Object({
  name: Type.Optional(Type.String()),
  dir: Type.Optional(Type.String()),
});
const documentIdParams = Type.Object({ id: Type.String() });
const openQuery = Type.Object({ download: Type.Optional(Type.String()) });
const documentContentBody = Type.Object({ content: Type.String() });
const folderBody = Type.Object({ path: Type.String() });
const folderQuery = Type.Object({ path: Type.String() });

export const libraryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Uploads arrive as the raw octet-stream body with the name in the query; no multipart needed for one file.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const status = async (): Promise<LibraryStatus> => ({
    folder: getLibraryDir(),
    folders: await listFolders(),
    documents: await listDocuments(),
  });

  app.get("/api/library", async () => status());

  app.post(
    "/api/library/folders",
    { schema: { body: folderBody } },
    async (req): Promise<LibraryStatus> => {
      const path = req.body.path.trim();
      if (!path) throw badRequest("folder name is empty");
      if (!(await createFolder(path))) throw badRequest("invalid folder path");
      return status();
    },
  );

  app.delete(
    "/api/library/folders",
    { schema: { querystring: folderQuery } },
    async (req): Promise<LibraryStatus> => {
      if (!(await deleteFolder(req.query.path))) throw notFound("folder not found");
      return status();
    },
  );

  app.get("/api/library/search", { schema: { querystring: librarySearchQuery } }, async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { results: [] };
    return { results: searchDocuments(q) };
  });

  app.post(
    "/api/library/files",
    { bodyLimit: UPLOAD_LIMIT, schema: { querystring: libraryFilesQuery } },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) {
        throw badRequest("send the file as application/octet-stream");
      }
      try {
        await saveUpload(req.query.name ?? "", req.body, req.query.dir?.trim() || "");
      } catch (error) {
        throw badRequest(errorMessage(error));
      }
      return status();
    },
  );

  app.get(
    "/api/library/documents/:id/content",
    { schema: { params: documentIdParams } },
    async (req): Promise<LibraryDocumentContent> => {
      const content = await readDocumentText(req.params.id);
      if (content === null) throw notFound("document is not an editable text file");
      return { content };
    },
  );

  app.put(
    "/api/library/documents/:id/content",
    { schema: { params: documentIdParams, body: documentContentBody } },
    async (req): Promise<LibraryStatus> => {
      const content = req.body.content.trim();
      if (!content) throw badRequest("content must not be empty");
      if (!(await writeDocumentText(req.params.id, `${content}\n`))) {
        throw notFound("document is not an editable text file");
      }
      return status();
    },
  );

  app.get(
    "/api/library/documents/:id/open",
    { schema: { params: documentIdParams, querystring: openQuery } },
    async (req, reply) => {
      const doc = await getDocument(req.params.id);
      if (!doc) throw notFound("document not found");

      const absPath = join(getLibraryDir(), doc.path);
      try {
        await stat(absPath);
      } catch {
        throw notFound("file not found on disk");
      }

      const mime = mimeForExt(doc.ext);
      // html/htm are mapped to text/plain so they render as inert source, not
      // executed; PDFs/text/images open inline, everything else downloads.
      // ?download forces the attachment path (the UI's download action).
      const inline = !req.query.download && inlineForMime(mime);
      const disposition = contentDisposition(
        inline ? "inline" : "attachment",
        `${doc.title}.${doc.ext}`,
      );

      return reply
        .header("Content-Type", mime)
        .header("Content-Disposition", disposition)
        .send(createReadStream(absPath));
    },
  );

  // Opens an agent-home folder in the OS file manager ("", "memory", "skills",
  // "knowledge", "knowledge/<dir>"); local-first, so the server and the user
  // share a machine.
  app.post("/api/library/reveal", { schema: { body: folderBody } }, async (req) => {
    const absPath = resolveWithin(getAgentHomeDir(), req.body.path.trim() || ".");
    if (!absPath) throw badRequest("path escapes the Trailin folder");
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(absPath);
    } catch {
      throw notFound("folder not found");
    }
    if (!stats.isDirectory()) throw badRequest("path is not a folder");
    openInFileManager(absPath);
    return { ok: true };
  });

  app.delete(
    "/api/library/documents/:id",
    { schema: { params: documentIdParams } },
    async (req) => {
      if (!(await deleteDocument(req.params.id))) {
        throw notFound("document not found");
      }
      return status();
    },
  );
};
