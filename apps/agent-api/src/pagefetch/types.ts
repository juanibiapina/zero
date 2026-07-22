// Page-fetch port (a true-external seam). Callers depend only on this
// interface; a Tavily-Extract adapter serves production and an in-memory
// adapter serves tests. Content is normalized (cleaned markdown, hard-capped)
// so a different provider drops in later without touching callers.

export interface PageContent {
  url: string;
  content: string; // cleaned page as markdown, truncated to a hard cap
}

export interface PageFetcher {
  fetch(url: string): Promise<PageContent>;
}
