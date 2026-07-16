// Web-search tool for the research agent. Wraps the WebSearch port so the agent
// can query the web and recover from failures (errors are returned as data, not
// thrown, so the loop can retry with a different query).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { WebSearch } from "../websearch/types";

export interface WebSearchToolDeps {
  search: WebSearch;
}

export const buildWebSearchTool = (deps: WebSearchToolDeps): ToolSet => {
  const { search } = deps;

  return {
    web_search: tool({
      description:
        "Search the web for current or external information. Call repeatedly with refined queries as needed. Returns a list of results, each with title, url, and snippet.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        try {
          return await search.search(query);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
};
