import { describe, expect, it } from "vitest";
import { buildResearchTool } from "./research";
import { scriptedModel } from "../agents/mock-model";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryFetcher } from "../pagefetch/memory";

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
  it("searches, writes findings to a new topic, and returns a handle naming it", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "far" },
    ]);
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "Mars distance" } }] },
      {
        tools: [
          { name: "create_topic", input: { name: "Mars", description: "the planet" } },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "Mars",
              body: "Mars is far. Source: https://ex.com/mars",
            },
          },
        ],
      },
      { text: "Wrote topic 'Mars'. Mars is far. Source: https://ex.com/mars" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search,
      fetcher: createMemoryFetcher(),
      accessed,
    });
    const result = await runResearch(tools, { prompt: "how far is Mars" });

    expect(store.getTopic("Mars")?.body).toBe(
      "Mars is far. Source: https://ex.com/mars",
    );
    expect([...accessed]).toEqual(["Mars"]);
    expect(result).toContain("Saved to topic 'Mars'.");
    expect(result).toContain("Source: https://ex.com/mars");
  });

  it("updates the existing topic in place on repeat research, preserving prior findings", async () => {
    const store = new MemoryStore();
    store.createTopic("Mars", "the planet");
    store.updateTopicBody("Mars", "Mars is far. Source: https://ex.com/mars");
    const accessed = new Set<string>();
    const search = createMemorySearch([
      { title: "Mars moons", url: "https://ex.com/moons", snippet: "two" },
    ]);
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "Mars" } }] },
      { tools: [{ name: "web_search", input: { query: "Mars moons" } }] },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "Mars",
              body:
                "Mars is far. Source: https://ex.com/mars\n\n" +
                "Mars has two moons. Source: https://ex.com/moons",
            },
          },
        ],
      },
      { text: "Updated topic 'Mars'." },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search,
      fetcher: createMemoryFetcher(),
      accessed,
    });
    await runResearch(tools, { prompt: "Mars moons", topic: "Mars" });

    expect(store.listTopics()).toHaveLength(1);
    const body = store.getTopic("Mars")?.body ?? "";
    expect(body).toContain("https://ex.com/mars");
    expect(body).toContain("https://ex.com/moons");
    expect([...accessed]).toEqual(["Mars"]);
  });

  it("creates a fallback topic when the agent writes none", async () => {
    const store = new MemoryStore();
    const accessed = new Set<string>();
    const model = scriptedModel([
      { text: "Mars is far. Source: https://ex.com/mars" },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      accessed,
    });
    const result = await runResearch(tools, { prompt: "how far is Mars" });

    expect(store.listTopics()).toHaveLength(1);
    const topic = store.getTopic("how far is Mars");
    expect(topic?.body).toBe("Mars is far. Source: https://ex.com/mars");
    expect([...accessed]).toEqual(["how far is Mars"]);
    expect(result).toContain("Saved to topic 'how far is Mars'.");
  });

  it("reads a full page with read_page and records its content", async () => {
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
      {
        tools: [
          {
            name: "create_topic",
            input: { name: "Mars", description: "the planet" },
          },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "Mars",
              body: "Mars is 225 million km away. Source: https://ex.com/mars",
            },
          },
        ],
      },
      { text: "Wrote topic 'Mars'." },
    ]);

    const tools = buildResearchTool({ model, store, search, fetcher, accessed });
    await runResearch(tools, { prompt: "how far is Mars" });

    expect(store.getTopic("Mars")?.body).toContain("225 million km");
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
      {
        tools: [
          {
            name: "create_topic",
            input: { name: "X", description: "x" },
          },
        ],
      },
      {
        tools: [
          { name: "update_topic", input: { name: "X", body: "No content." } },
        ],
      },
      { text: "Wrote topic 'X'." },
    ]);

    const tools = buildResearchTool({
      model,
      store,
      search: createMemorySearch(),
      fetcher,
      accessed,
    });
    const result = await runResearch(tools, { prompt: "read x" });

    // The loop recovered from the fetch error and still wrote a topic.
    expect(store.getTopic("X")?.body).toBe("No content.");
    expect(result).toContain("Saved to topic 'X'.");
  });
});
