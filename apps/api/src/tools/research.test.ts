import { describe, expect, it } from "vitest";
import type { ToolExecutionOptions } from "ai";
import { buildResearchTool } from "./research";
import { scriptedModel } from "../agents/mock-model";
import { createMemorySearch } from "../websearch/memory";

type ResearchExecute = (
  input: { prompt: string },
  options: ToolExecutionOptions<never>,
) => Promise<string>;

const runResearch = (
  tools: ReturnType<typeof buildResearchTool>,
  prompt: string,
): Promise<string> => {
  const execute = tools.research.execute as unknown as ResearchExecute;
  return execute({ prompt }, {} as ToolExecutionOptions<never>);
};

describe("buildResearchTool", () => {
  it("runs a research agent and returns its final summary", async () => {
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com", snippet: "far" },
    ]);
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "Mars distance" } }] },
      { text: "Mars is far. Source: https://ex.com" },
    ]);

    const tools = buildResearchTool({ model, search });
    const result = await runResearch(tools, "how far is Mars");

    expect(result).toBe("Mars is far. Source: https://ex.com");
  });

  it("falls back to 'No findings.' when the agent returns empty text", async () => {
    const model = scriptedModel([{ text: "" }]);
    const tools = buildResearchTool({ model, search: createMemorySearch() });

    const result = await runResearch(tools, "anything");

    expect(result).toBe("No findings.");
  });
});
