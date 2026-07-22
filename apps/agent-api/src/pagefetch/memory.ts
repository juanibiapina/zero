// In-memory PageFetcher adapter for tests. Returns deterministic canned content
// keyed by URL so agent loops are reproducible. Unknown URLs return empty
// content (the tool still succeeds); pass a map to script specific pages.

import type { PageContent, PageFetcher } from "./types";

export const createMemoryFetcher = (
  byUrl: Record<string, string> = {},
): PageFetcher => ({
  async fetch(url: string): Promise<PageContent> {
    return { url, content: byUrl[url] ?? "" };
  },
});
