// In-memory WebSearch adapter for tests. Returns deterministic canned results
// regardless of the query so agent loops are reproducible.

import type { SearchResult, WebSearch } from "./types";

export const createMemorySearch = (results: SearchResult[] = []): WebSearch => ({
  async search(): Promise<SearchResult[]> {
    return results;
  },
});
