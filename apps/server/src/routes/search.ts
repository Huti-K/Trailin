import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { SearchResult } from "@trailin/shared";
import { likeContains } from "../db/like.js";
import {
  safeSource,
  searchChats,
  searchDocuments,
  searchDrafts,
  searchMemories,
  searchRuns,
} from "../search/sources.js";

const searchQuery = Type.Object({ q: Type.Optional(Type.String()) });

export const searchRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/search", { schema: { querystring: searchQuery } }, async (req) => {
    const query = (req.query.q ?? "").trim();
    if (!query) return { results: [] };
    const pattern = likeContains(query);

    const [runs, chats, drafts, documents, memories] = await Promise.all([
      safeSource("runs", searchRuns(query, pattern)),
      safeSource("chats", searchChats(query, pattern)),
      safeSource("drafts", searchDrafts(query)),
      safeSource("documents", searchDocuments(query)),
      safeSource("memories", searchMemories(query)),
    ]);

    const results: SearchResult[] = [...runs, ...chats, ...drafts, ...documents, ...memories];
    return { results };
  });
};
