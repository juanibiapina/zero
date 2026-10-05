// Page-fetch tool. Wraps the PageFetcher port so the interface agent can read
// the full cleaned content of a specific web page on demand: an address the
// user hands over, or a result `web_search` turned up. Errors are returned as
// data, not thrown, so the loop continues (mirrors web-search.ts). Neither the
// address nor the page content is logged.

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
        "Open and read a web address. Returns cleaned Markdown or an error.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const start = Date.now();
        try {
          const page = await fetcher.fetch(url);
          log("read_page_completed", {
            duration_ms: Date.now() - start,
            content_len: page.content.length,
          });
          return page;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("read_page_failed", {
            duration_ms: Date.now() - start,
            error: message,
          });
          return { error: message };
        }
      },
    }),
  };
};
