// Page-fetch tool. Wraps the PageFetcher port so an agent can read the full
// cleaned content of a specific web page on demand. Registered on BOTH the
// interface agent (the user hands over a link, no research run needed) and the
// research agent (opening a search result). The `caller` label separates the two
// in logs. Errors are returned as data, not thrown, so the loop continues
// (mirrors web-search.ts). Neither the address nor the page content is logged.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import type { PageFetcher } from "../pagefetch/types";

export type ReadPageCaller = "interface" | "research";

export interface ReadPageToolDeps {
  fetcher: PageFetcher;
  caller: ReadPageCaller;
}

export const buildReadPageTool = (deps: ReadPageToolDeps): AgentToolSet => {
  const { fetcher, caller } = deps;

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
            caller,
            duration_ms: Date.now() - start,
            content_len: page.content.length,
          });
          return page;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("read_page_failed", {
            caller,
            duration_ms: Date.now() - start,
            error: message,
          });
          return { error: message };
        }
      },
    }),
  };
};
