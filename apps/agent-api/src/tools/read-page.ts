// Page-fetch tool for the research agent. Wraps the PageFetcher port so the
// agent can read the full cleaned content of a specific web page on demand
// (web_search returns only snippets). Errors are returned as data, not thrown,
// so the loop continues (mirrors web-search.ts).

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import type { PageFetcher } from "../pagefetch/types";

export interface ReadPageToolDeps {
  fetcher: PageFetcher;
}

export const buildReadPageTool = (deps: ReadPageToolDeps): AgentToolSet => {
  const { fetcher } = deps;

  return {
    read_page: defineTool({
      description:
        "Fetch and read the full cleaned content of a web page by URL. " +
        "web_search returns only short snippets; call read_page on a result's " +
        "url when that result looks important and you need the full text before " +
        "relying on it. Returns the page content as markdown, or { error }.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        try {
          return await fetcher.fetch(url);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("read_page_failed", { error: message });
          return { error: message };
        }
      },
    }),
  };
};
