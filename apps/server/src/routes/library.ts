import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { LibraryStatus } from "@trailin/shared";
import { deleteDocument, getLibraryDir, saveUpload, setLibraryFolder } from "../library/ingest.js";
import { pickFolder } from "../library/pickFolder.js";
import { getDocument, listDocuments, searchChunks, type SearchHit } from "../library/store.js";
import { badRequest, notFound } from "../errors.js";
import { errorMessage } from "../util.js";

const UPLOAD_LIMIT = 64 * 1024 * 1024;

export interface LibrarySearchHit {
  id: string;
  title: string;
  path: string;
  ext: string;
  snippet: string;
}

// Over-fetch chunk-level hits so collapsing them to one entry per document
// still leaves close to SEARCH_DOC_LIMIT distinct documents.
const SEARCH_DOC_LIMIT = 20;
const SEARCH_CHUNK_LIMIT = 80;

/** Collapse whitespace and cap length, breaking on a word boundary. */
function trimSnippet(value: string, max = 200): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** BM25 chunk search collapsed to one best-ranked hit per document. */
function searchDocuments(q: string): LibrarySearchHit[] {
  let hits: SearchHit[];
  try {
    hits = searchChunks(q, SEARCH_CHUNK_LIMIT);
  } catch {
    // buildMatch() already quotes extracted terms, but guard here too in
    // case the FTS5 engine still rejects the input — retry sanitized rather
    // than letting the request 500.
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

/** Map file extension to a browser-friendly MIME type. */
function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "md":
    case "markdown":
    case "txt":
    case "csv":
      return "text/plain; charset=utf-8";
    case "html":
    case "htm":
      // Never text/html: library folders hold sender-controlled content
      // (saved email exports), and serving that inline as HTML on the app
      // origin would let its script call every /api endpoint.
      return "text/plain; charset=utf-8";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

/**
 * Build a Content-Disposition header value for a filename that may contain
 * non-Latin1 or quote characters, which Node's raw header serializer rejects
 * (ERR_INVALID_CHAR) or which would otherwise malform the quoted-string.
 * Ships an ASCII `filename` fallback plus the exact name via RFC 5987/6266
 * `filename*`.
 */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[\\"]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The document library: list, upload into the drop folder, rescan, delete. */
export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // Uploads arrive as the raw file body (application/octet-stream), the name
  // in the query string — no multipart dependency needed for one file.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const status = async (): Promise<LibraryStatus> => ({
    folder: getLibraryDir(),
    documents: await listDocuments(),
  });

  app.get("/api/library", async () => status());

  app.get<{ Querystring: { q?: string } }>("/api/library/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { results: [] };
    return { results: searchDocuments(q) };
  });

  app.put<{ Body: { folder?: string } }>("/api/library/folder", async (req) => {
    try {
      await setLibraryFolder(req.body?.folder ?? "");
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    return status();
  });

  // Opens the OS's native folder-picker dialog on the server's machine and,
  // unless the user cancels, applies the chosen folder — same validation as
  // the manual PUT above, since setLibraryFolder does the actual switching.
  app.post("/api/library/folder/pick", async () => {
    try {
      const picked = await pickFolder();
      if ("canceled" in picked) return { canceled: true };
      await setLibraryFolder(picked.path);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    return status();
  });

  app.post<{ Querystring: { name?: string } }>(
    "/api/library/files",
    { bodyLimit: UPLOAD_LIMIT },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) {
        throw badRequest("send the file as application/octet-stream");
      }
      try {
        await saveUpload(req.query.name ?? "", req.body);
      } catch (error) {
        throw badRequest(errorMessage(error));
      }
      return status();
    },
  );

  // Stream the original file so the browser can view/download it.
  app.get<{ Params: { id: string } }>("/api/library/documents/:id/open", async (req, reply) => {
    const doc = await getDocument(req.params.id);
    if (!doc) throw notFound("document not found");

    const absPath = join(getLibraryDir(), doc.path);
    try {
      await stat(absPath);
    } catch {
      throw notFound("file not found on disk");
    }

    const mime = mimeForExt(doc.ext);
    // PDFs and plain text (html/htm included, mapped to text/plain above so
    // it renders as inert source rather than executing) open in-browser;
    // everything else downloads.
    const inline = /^(application\/pdf|text\/plain)/.test(mime);
    const disposition = contentDisposition(
      inline ? "inline" : "attachment",
      `${doc.title}.${doc.ext}`,
    );

    return reply
      .header("Content-Type", mime)
      .header("Content-Disposition", disposition)
      .send(createReadStream(absPath));
  });

  app.delete<{ Params: { id: string } }>("/api/library/documents/:id", async (req) => {
    if (!(await deleteDocument(req.params.id))) {
      throw notFound("document not found");
    }
    return status();
  });
}
