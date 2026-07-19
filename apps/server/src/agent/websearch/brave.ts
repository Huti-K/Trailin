import type { Freshness, WebSearchResult } from "./search.js";

export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const FRESHNESS_CODES: Record<Freshness, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

function decodeCodePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

/** Brave snippets carry highlight markup (<strong>) and entities; strip to plain text. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(
      /&#x([0-9a-f]+);/gi,
      (match, hex: string) => decodeCodePoint(parseInt(hex, 16)) ?? match,
    )
    .replace(/&#(\d+);/g, (match, dec: string) => decodeCodePoint(Number(dec)) ?? match)
    .trim();
}

export async function braveWebSearch(opts: {
  apiKey: string;
  query: string;
  count: number;
  freshness?: Freshness;
  signal?: AbortSignal;
}): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ q: opts.query, count: String(opts.count) });
  if (opts.freshness) params.set("freshness", FRESHNESS_CODES[opts.freshness]);

  const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": opts.apiKey,
    },
    signal: opts.signal ?? null,
  });
  if (!response.ok) {
    // 401/403 bad key, 422 bad params, 429 quota: surface verbatim so the model can tell the user what's wrong.
    throw new Error(`Brave Search request failed: ${response.status} ${response.statusText}`);
  }

  // External API response: parse to unknown and narrow, per the trust rules.
  const body = (await response.json()) as unknown;
  const results = (body as { web?: { results?: unknown } })?.web?.results;
  if (!Array.isArray(results)) return [];

  const rows: WebSearchResult[] = [];
  for (const entry of results) {
    const row = entry as { title?: unknown; url?: unknown; description?: unknown; age?: unknown };
    if (typeof row.title !== "string" || typeof row.url !== "string") continue;
    rows.push({
      title: stripHtml(row.title),
      url: row.url,
      description: typeof row.description === "string" ? stripHtml(row.description) : undefined,
      age: typeof row.age === "string" ? row.age : undefined,
    });
  }
  return rows;
}
