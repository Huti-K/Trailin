import { env } from "../../core/env.js";
import { braveWebSearch } from "./brave.js";
import { exaWebSearch } from "./exa.js";

export type Freshness = "day" | "week" | "month" | "year";

export interface WebSearchResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
}

export async function webSearch(opts: {
  query: string;
  count: number;
  freshness?: Freshness;
  signal?: AbortSignal;
}): Promise<WebSearchResult[]> {
  const apiKey = env.webSearch.braveApiKey;
  if (apiKey) return braveWebSearch({ ...opts, apiKey });
  return exaWebSearch(opts);
}
