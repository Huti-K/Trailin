import { moduleLogger } from "../../core/logger.js";
import type { Freshness, WebSearchResult } from "./search.js";

const log = moduleLogger("exa-search");

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

const CONTEXT_MAX_CHARACTERS = 4000;

/** The MCP endpoint has no structured freshness filter; recency rides in the query text as a hint. */
function freshnessHint(freshness: Freshness): string {
  const now = new Date();
  switch (freshness) {
    case "day":
      return "past 24 hours";
    case "week":
      return "past week";
    case "month":
      return `${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`;
    case "year":
      return String(now.getFullYear());
  }
}

interface ExaMcpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

/** The reply may be plain JSON or an SSE stream; find the first RPC payload either way. */
function parseRpcBody(body: string): ExaMcpRpcResponse | null {
  const candidates = [
    ...body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()),
    body,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as ExaMcpRpcResponse;
      if (parsed?.result || parsed?.error) return parsed;
    } catch {
      // Not this line; keep scanning.
    }
  }
  return null;
}

function parseResults(text: string): WebSearchResult[] {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  const rows: WebSearchResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
    if (!url) continue;
    const published = block.match(/^Published: (.+)/m)?.[1]?.trim();
    let content = "";
    const textStart = block.indexOf("\nText: ");
    const highlights = block.match(/\nHighlights:\s*\n/);
    if (textStart >= 0) {
      content = block.slice(textStart + 7);
    } else if (highlights?.index !== undefined) {
      content = block.slice(highlights.index + highlights[0].length);
    }
    content = content
      .replace(/\n---\s*$/, "")
      .replace(/\n\.\.\.\n/g, " … ")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    rows.push({
      title,
      url,
      description: content || undefined,
      age: published && published !== "N/A" ? published : undefined,
    });
  }
  return rows;
}

export async function exaWebSearch(opts: {
  query: string;
  count: number;
  freshness?: Freshness;
  signal?: AbortSignal;
}): Promise<WebSearchResult[]> {
  const query = opts.freshness ? `${opts.query} ${freshnessHint(opts.freshness)}` : opts.query;
  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults: opts.count,
          livecrawl: "fallback",
          type: "auto",
          contextMaxCharacters: CONTEXT_MAX_CHARACTERS,
        },
      },
    }),
    signal: opts.signal ?? null,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Exa search failed: ${response.status} ${detail}`);
  }

  const parsed = parseRpcBody(await response.text());
  if (!parsed) throw new Error("Exa search returned an unreadable response");
  if (parsed.error) {
    throw new Error(`Exa search failed: ${parsed.error.message || "unknown error"}`);
  }
  const text = parsed.result?.content?.find(
    (item) => item.type === "text" && typeof item.text === "string" && item.text.trim(),
  )?.text;
  if (parsed.result?.isError) {
    throw new Error(text?.trim() || "Exa search returned an error");
  }
  if (!text) return [];
  const rows = parseResults(text);
  // Zero blocks from a non-empty reply means the "Title:/URL:" marker format
  // drifted; without this it's indistinguishable from "no results".
  if (rows.length === 0) {
    log.warn({ sample: text.slice(0, 300) }, "Exa reply parsed to zero results");
  }
  return rows;
}
