// Research tool for the interface agent. Calling it spawns a research-prompted
// agent (the same runner) armed with a web_search tool; that agent's final
// message becomes the tool result. Reuses the interface agent's model instance
// so per-user gateway attribution is preserved.

import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent } from "../agents/run";
import { researchSystemPrompt } from "../agents/prompts";
import { buildWebSearchTool } from "./web-search";
import { log } from "../log";
import type { WebSearch } from "../websearch/types";

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
        log("research_started", { prompt_len: prompt.length });
        const start = Date.now();
        const { text, finishReason, steps } = await runAgent({
          model,
          system: researchSystemPrompt(),
          prompt,
          tools: buildWebSearchTool({ search }),
        });
        log("research_completed", {
          steps,
          finish_reason: finishReason,
          duration_ms: Date.now() - start,
          result_len: text.length,
        });
        return text || "No findings.";
      },
    }),
  };
};
