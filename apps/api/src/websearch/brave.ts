// Brave Search adapter for the WebSearch port. Calls the Brave Web Search API
// and normalizes its payload to SearchResult[]. Uses the global Workers fetch.

import type { SearchResult, WebSearch } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BravePayload {
  web?: { results?: BraveWebResult[] };
}

export const createBraveSearch = (apiKey: string): WebSearch => ({
  async search(query: string): Promise<SearchResult[]> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${DEFAULT_COUNT}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
    }
    const data: BravePayload = await res.json();
    const results = data.web?.results ?? [];
    return results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  },
});
