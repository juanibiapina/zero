// Web-search tool for the research agent. Wraps the WebSearch port so the agent
// can query the web and recover from failures (errors are returned as data, not
// thrown, so the loop can retry with a different query).
//
// The port is `search(query)` and stays that way, so the adapter cannot know
// which research run a request belongs to. Run-scoped accounting lives here
// instead: an optional stats collector (same idiom as the `accessed` set that
// buildTopicTools fills) lets research report what a single run cost. Brave
// bills per query, so that number is the unit of spend.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import { queryHash } from "../query-hash";
import type { WebSearch } from "../websearch/types";

// Mutable, caller-owned tally of one run's searches. `queries` holds query
// hashes, never query text, so `unique_queries` can be compared against `calls`
// to spot a loop re-issuing the same search until the step cap.
export interface WebSearchStats {
  calls: number;
  failed: number;
  empty: number;
  durationMs: number;
  queries: Set<string>;
}

export const newWebSearchStats = (): WebSearchStats => ({
  calls: 0,
  failed: 0,
  empty: 0,
  durationMs: 0,
  queries: new Set<string>(),
});

export interface WebSearchToolDeps {
  search: WebSearch;
  stats?: WebSearchStats;
}

export const buildWebSearchTool = (deps: WebSearchToolDeps): AgentToolSet => {
  const { search, stats } = deps;

  return {
    web_search: defineTool({
      description:
        "Search the web for current or external information. Call repeatedly with refined queries as needed. Returns a list of results, each with title, url, and snippet.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hash = queryHash(query);
        const repeat = stats?.queries.has(hash) ?? false;
        const start = Date.now();
        if (stats) {
          stats.calls++;
          stats.queries.add(hash);
        }

        try {
          const results = await search.search(query);
          const durationMs = Date.now() - start;
          if (stats) {
            stats.durationMs += durationMs;
            if (results.length === 0) stats.empty++;
          }
          log("web_search_completed", {
            query_hash: hash,
            query_len: query.length,
            result_count: results.length,
            duration_ms: durationMs,
            repeat,
          });
          return results;
        } catch (err) {
          const durationMs = Date.now() - start;
          if (stats) {
            stats.durationMs += durationMs;
            stats.failed++;
          }
          const message = err instanceof Error ? err.message : String(err);
          log("web_search_failed", {
            query_hash: hash,
            query_len: query.length,
            duration_ms: durationMs,
            repeat,
            error: message,
          });
          return { error: message };
        }
      },
    }),
  };
};
