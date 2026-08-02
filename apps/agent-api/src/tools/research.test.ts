import { describe, expect, it, vi } from "vitest";
import { buildResearchTool, RESEARCH_MAX_STEPS } from "./research";
import { scriptedModel } from "../agents/mock-model";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { seedTopic, setBody } from "../store/test-support";

type ResearchExecute = (input: {
  prompt: string;
  topic?: string;
}) => Promise<string>;

const runResearch = (
  tools: ReturnType<typeof buildResearchTool>,
  input: { prompt: string; topic?: string },
): Promise<string> => {
  const execute = tools.research.execute as unknown as ResearchExecute;
  return execute(input);
};

describe("buildResearchTool", () => {
  it("returns the sourced findings report as the tool result and writes no topic", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "far" },
    ]);
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "Mars distance" } }] },
      {
        text:
          "- Mars is far. Source: https://ex.com/mars\n\nSummary: Mars is distant.",
      },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search,
      fetcher: createMemoryFetcher(),
      accessed,
    });
    const result = await runResearch(tools, { prompt: "how far is Mars" });

    // Research authors nothing; the writer persists findings afterward.
    expect(store.listTopics()).toHaveLength(0);
    // The tool result IS the findings text, with sources inline.
    expect(result).toContain("Source: https://ex.com/mars");
    expect(result).toBe(
      "- Mars is far. Source: https://ex.com/mars\n\nSummary: Mars is distant.",
    );
  });

  it("has no write tools: a create_topic/update_topic call is rejected and writes nothing", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    // The scripted model tries to write; the runner should return an unknown-tool
    // error for each, then finish on the text step, having stored nothing.
    const model = scriptedModel([
      {
        tools: [{ name: "create_topic", input: { name: "Mars", description: "x" } }],
      },
      {
        tools: [{ name: "update_topic", input: { name: "Mars", body: "x" } }],
      },
      { text: "- Mars is far. Source: https://ex.com/mars" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      accessed,
    });
    const result = await runResearch(tools, { prompt: "how far is Mars" });

    expect(store.listTopics()).toHaveLength(0);
    expect(result).toContain("Source: https://ex.com/mars");
  });

  it("records topics it read via get_topic in the accessed set without modifying them", async () => {
    const store = new MemoryStore();
    seedTopic(store, "Mars", "the planet");
    setBody(store, "Mars", "Mars is far. Source: https://ex.com/mars");
    const accessed = new Set<string>();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "Mars" } }] },
      { text: "- Mars has two moons. Source: https://ex.com/moons" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      accessed,
    });
    const result = await runResearch(tools, { prompt: "Mars moons", topic: "Mars" });

    // The read topic is surfaced to the writer via accessed.
    expect([...accessed]).toEqual(["Mars"]);
    // Research did not touch the stored body.
    expect(store.getTopic("Mars")?.body).toBe(
      "Mars is far. Source: https://ex.com/mars",
    );
    expect(result).toContain("Source: https://ex.com/moons");
  });

  it("reads a full page with read_page and can rely on its content", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "far" },
    ]);
    const fetcher = createMemoryFetcher({
      "https://ex.com/mars": "Mars is 225 million km away on average.",
    });
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "Mars distance" } }] },
      { tools: [{ name: "read_page", input: { url: "https://ex.com/mars" } }] },
      { text: "- Mars is 225 million km away. Source: https://ex.com/mars" },
    ]);

    const tools = buildResearchTool({ model, store, search, fetcher, accessed });
    const result = await runResearch(tools, { prompt: "how far is Mars" });

    expect(result).toContain("225 million km");
    expect(store.listTopics()).toHaveLength(0);
  });

  it("surfaces a read_page fetch error as data and keeps looping", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    const fetcher = {
      fetch: async () => {
        throw new Error("page fetch failed: 500");
      },
    };
    const model = scriptedModel([
      { tools: [{ name: "read_page", input: { url: "https://ex.com/x" } }] },
      { text: "- No content found. Source: https://ex.com/x" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch(),
      fetcher,
      accessed,
    });
    const result = await runResearch(tools, { prompt: "read x" });

    // The loop recovered from the fetch error and still produced a report.
    expect(result).toContain("Source: https://ex.com/x");
    expect(store.listTopics()).toHaveLength(0);
  });

  it("reports what the run's searches cost", async () => {
    // Brave bills per query and the loop can fan out several tool calls per
    // step, so `steps` says nothing about spend. This line is what does.
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args[0] as Record<string, unknown>);
    });

    const store = new MemoryStore();
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "Mars distance" } }] },
      { tools: [{ name: "web_search", input: { query: "mars distance" } }] },
      { tools: [{ name: "web_search", input: { query: "Mars moons" } }] },
      { text: "- Mars is far. Source: https://ex.com/mars" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch([
        { title: "Mars", url: "https://ex.com/mars", snippet: "far" },
      ]),
      fetcher: createMemoryFetcher(),
      accessed: new Set<string>(),
    });
    await runResearch(tools, { prompt: "how far is Mars" });

    expect(lines.find((l) => l.msg === "research_completed")).toMatchObject({
      searches: 3,
      searches_failed: 0,
      searches_empty: 0,
      // "Mars distance" and "mars distance" are the same search to Brave.
      unique_queries: 2,
    });

    vi.restoreAllMocks();
  });

  it("uses a generous research step bound, not a tight one", () => {
    // The incident loop ran 20+ steps; step exhaustion returns an empty report,
    // so the bound must sit well above that.
    expect(RESEARCH_MAX_STEPS).toBeGreaterThanOrEqual(30);
  });
});
