import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWebSearchTool,
  newWebSearchStats,
  type WebSearchStats,
} from "./web-search";
import { createMemorySearch } from "../websearch/memory";
import type { SearchResult, WebSearch } from "../websearch/types";

afterEach(() => {
  vi.restoreAllMocks();
});

type WebSearchExecute = (input: {
  query: string;
}) => Promise<SearchResult[] | { error: string }>;

const run = (
  search: WebSearch,
  query: string,
  stats?: WebSearchStats,
): Promise<SearchResult[] | { error: string }> => {
  const tool = buildWebSearchTool({ search, stats }).web_search;
  return (tool.execute as unknown as WebSearchExecute)({ query });
};

const failingSearch = (message: string): WebSearch => ({
  search: async () => {
    throw new Error(message);
  },
});

const logLines = () => {
  const lines: unknown[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args[0]);
  });
  return lines as Record<string, unknown>[];
};

const hit = (): SearchResult[] => [
  { title: "T", url: "https://ex.com", snippet: "s" },
];

describe("buildWebSearchTool", () => {
  it("returns results and logs the result count and duration", async () => {
    const lines = logLines();

    const result = await run(createMemorySearch(hit()), "mars distance");

    expect(result).toEqual(hit());
    const done = lines.find((l) => l.msg === "web_search_completed");
    expect(done).toMatchObject({ result_count: 1, repeat: false });
    expect(typeof done?.duration_ms).toBe("number");
    expect(typeof done?.query_hash).toBe("string");
  });

  it("returns the failure as data and logs it", async () => {
    const lines = logLines();

    const result = await run(failingSearch("Brave search failed: 429"), "q");

    expect(result).toEqual({ error: "Brave search failed: 429" });
    const failed = lines.find((l) => l.msg === "web_search_failed");
    expect(failed).toMatchObject({ error: "Brave search failed: 429" });
    expect(typeof failed?.duration_ms).toBe("number");
  });

  it("logs no query text", async () => {
    const lines = logLines();
    const secret = "juan medical appointment berlin";

    await run(createMemorySearch(hit()), secret);
    await run(failingSearch("boom"), secret);

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("medical");
    expect(serialized).not.toContain(secret);
  });

  it("tallies calls, failures, empties, duration and unique queries", async () => {
    const stats = newWebSearchStats();

    await run(createMemorySearch(hit()), "a", stats);
    await run(createMemorySearch([]), "b", stats);
    await run(failingSearch("boom"), "c", stats);

    expect(stats.calls).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.empty).toBe(1);
    expect(stats.queries.size).toBe(3);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts a repeated query once in unique queries and flags it as a repeat", async () => {
    const lines = logLines();
    const stats = newWebSearchStats();
    const search = createMemorySearch(hit());

    await run(search, "same query", stats);
    await run(search, "  SAME Query  ", stats);

    expect(stats.calls).toBe(2);
    expect(stats.queries.size).toBe(1);
    expect(
      lines.filter((l) => l.msg === "web_search_completed").map((l) => l.repeat),
    ).toEqual([false, true]);
  });
});
