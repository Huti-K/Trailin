import { randomUUID } from "node:crypto";
import type { LibraryDocument } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { db, lazyStatement, lazyTransaction, schema } from "../../db/index.js";
import { buildFtsMatch, upsertSql } from "../../db/sql.js";

/**
 * SQLite persistence for the document library: metadata in library_documents,
 * extracted text as ordered chunks in the library_chunks FTS5 table (BM25
 * keyword search). Chunks are contiguous slices, so joining them restores the
 * full text.
 */

export interface DocumentInput {
  path: string;
  title: string;
  ext: string;
  size: number;
  mtimeMs: number;
  status: "indexed" | "error";
  error: string | null;
  textLength: number;
}

export interface SearchHit {
  documentId: string;
  path: string;
  title: string;
  ext: string;
  seq: number;
  snippet: string;
}

const upsertDocumentStmt = lazyStatement(
  upsertSql({
    table: "library_documents",
    conflict: ["path"],
    insertOnly: ["id"],
    update: [
      "title",
      "ext",
      "size",
      "mtime_ms",
      "status",
      "error",
      "chunk_count",
      "text_length",
      "indexed_at",
    ],
  }),
);
const selectIdByPath = lazyStatement(`SELECT id FROM library_documents WHERE path = ?`);
const deleteDocumentStmt = lazyStatement(`DELETE FROM library_documents WHERE id = ?`);
const insertChunkStmt = lazyStatement(
  `INSERT INTO library_chunks (content, doc_id, seq) VALUES (?, ?, ?)`,
);
const deleteChunksStmt = lazyStatement(`DELETE FROM library_chunks WHERE doc_id = ?`);
const selectChunksStmt = lazyStatement(
  `SELECT content FROM library_chunks WHERE doc_id = ? ORDER BY seq`,
);

/** Write a document and its chunks atomically; the id stays stable across re-indexes. */
export const replaceDocument = lazyTransaction((doc: DocumentInput, chunks: string[]): string => {
  const existing = selectIdByPath().get(doc.path) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  upsertDocumentStmt().run({
    id,
    ...doc,
    chunkCount: chunks.length,
    indexedAt: new Date().toISOString(),
  });
  deleteChunksStmt().run(id);
  chunks.forEach((content, seq) => {
    insertChunkStmt().run(content, id, seq);
  });
  return id;
});

export const removeDocument = lazyTransaction((id: string): void => {
  deleteChunksStmt().run(id);
  deleteDocumentStmt().run(id);
});

function toShared(row: typeof schema.libraryDocuments.$inferSelect): LibraryDocument {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    ext: row.ext,
    size: row.size,
    status: row.status,
    error: row.error,
    chunkCount: row.chunkCount,
    textLength: row.textLength,
    modifiedAt: new Date(row.mtimeMs).toISOString(),
    indexedAt: row.indexedAt,
  };
}

export async function listDocuments(): Promise<LibraryDocument[]> {
  const rows = await db
    .select()
    .from(schema.libraryDocuments)
    .orderBy(schema.libraryDocuments.path);
  return rows.map(toShared);
}

export async function getDocument(id: string): Promise<LibraryDocument | null> {
  const [row] = await db
    .select()
    .from(schema.libraryDocuments)
    .where(eq(schema.libraryDocuments.id, id));
  return row ? toShared(row) : null;
}

/** One document's extracted text, as ordered chunks (join to restore the text). */
export function readDocumentChunks(id: string): string[] {
  const rows = selectChunksStmt().all(id) as { content: string }[];
  return rows.map((r) => r.content);
}

const searchStmt = lazyStatement(`
  SELECT c.doc_id AS documentId, c.seq AS seq, d.path AS path, d.title AS title, d.ext AS ext,
         snippet(library_chunks, 0, '', '', ' … ', 24) AS snippet
  FROM library_chunks c
  JOIN library_documents d ON d.id = c.doc_id
  WHERE library_chunks MATCH ?
  ORDER BY bm25(library_chunks)
  LIMIT ?
`);

/** BM25 keyword search: all terms first, any term as the fallback. */
export function searchChunks(query: string, limit: number): SearchHit[] {
  const run = (match: string | null) =>
    match ? (searchStmt().all(match, limit) as SearchHit[]) : [];
  const strict = run(buildFtsMatch(query, "AND"));
  if (strict.length > 0) return strict;
  return run(buildFtsMatch(query, "OR"));
}
