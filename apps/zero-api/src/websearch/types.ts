// Web-search port (a true-external seam). Callers depend only on this
// interface; a Brave adapter serves production and an in-memory adapter serves
// tests. Results are normalized so a different provider (e.g. Tavily) drops in
// later without touching callers.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string): Promise<SearchResult[]>;
}
