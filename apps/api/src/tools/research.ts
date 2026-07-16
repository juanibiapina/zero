// Research tool for the interface agent. Calling it spawns a research-prompted
// agent (the same runner) armed with a web_search tool; that agent's final
// message becomes the tool result. Reuses the interface agent's model instance
// so per-user gateway attribution is preserved.

import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent } from "../agents/run";
import { researchSystemPrompt } from "../agents/prompts";
import { buildWebSearchTool } from "./web-search";
import type { WebSearch } from "../websearch/types";

const RESEARCH_MAX_STEPS = 8;

export interface ResearchToolDeps {
  model: LanguageModel;
  search: WebSearch;
}

export const buildResearchTool = (deps: ResearchToolDeps): ToolSet => {
  const { model, search } = deps;

  return {
    research: tool({
      description:
        "Research a question using web search. Use for questions needing current or external information the topics do not cover. Adds latency, so acknowledge the user with reply first. Returns a concise sourced summary.",
      inputSchema: z.object({ prompt: z.string() }),
      execute: async ({ prompt }) => {
        const text = await runAgent({
          model,
          system: researchSystemPrompt(),
          prompt,
          tools: buildWebSearchTool({ search }),
          maxSteps: RESEARCH_MAX_STEPS,
        });
        return text || "No findings.";
      },
    }),
  };
};
