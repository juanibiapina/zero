// Research tool for the interface agent. Calling it spawns a research-prompted
// agent (the same runner) armed with READ-ONLY topic tools (list_topics,
// get_topic) + web_search + read_page; that agent reads related topics for
// context, investigates with web search, and RETURNS a short sourced findings
// report as its final message. It has no write tools: the writer agent that runs
// after every turn persists the findings into topics. Authoring full topic
// bodies inside this loop was the dominant cost (5-8k output tokens per write),
// so removing the write tools is what makes research fast. Reuses the interface
// agent's model instance so per-user gateway attribution is preserved.

import {
  defineTool,
  type AgentModel,
  type AgentToolSet,
} from "../agents/protocol";
import { z } from "zod";
import { runAgent, usageLogFields } from "../agents/run";
import { researchSystemPrompt } from "../agents/prompts";
import { buildTopicTools } from "./topics";
import { buildWebSearchTool } from "./web-search";
import { buildReadPageTool } from "./read-page";
import { log } from "../log";
import type { TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { PageFetcher } from "../pagefetch/types";

// Research-specific step cap. The default AGENT_MAX_STEPS (200) is a runaway
// guard for the interface loop; research wants its own, generous bound. It must
// NOT be tight: the incident research loop ran 20+ steps, and hitting the cap
// returns an empty report (run.ts returns text: "" on exhaustion), which is
// worse than a slow one. A gather-and-report loop with several read_page calls
// finishes well under this; ~40 leaves ample headroom over the observed 20+
// while still bounding a pathological loop.
export const RESEARCH_MAX_STEPS = 40;

export interface ResearchToolDeps {
  model: AgentModel;
  store: TopicStore;
  search: WebSearch;
  // Page-fetch port for the read_page tool. Threaded exactly like `search`.
  fetcher: PageFetcher;
  // The interface agent's accessed set. Topics the research agent READS (via
  // get_topic) are merged in so the writer still knows which topics are relevant
  // to this turn. Research writes nothing, so nothing is added here for writes.
  accessed: Set<string>;
}

export const buildResearchTool = (deps: ResearchToolDeps): AgentToolSet => {
  const { model, store, search, fetcher, accessed } = deps;

  return {
    research: defineTool({
      description:
        "Research a subject using web search and report back a short sourced " +
        "summary. Use proactively whenever the user mentions a researchable " +
        "subject (a company, product, technology, person, place, or event) or " +
        "makes a claim worth checking — not only for explicit questions. It " +
        "reads existing topics for context, so if the subject already has a " +
        "topic, pass its name as `topic`. Adds latency, so acknowledge the user " +
        "with reply first. Returns a sourced findings report; another agent " +
        "saves it into a topic afterward.",
      inputSchema: z.object({
        prompt: z.string(),
        topic: z.string().optional(),
      }),
      execute: async ({ prompt, topic }) => {
        log("research_started", { prompt_len: prompt.length, has_topic: !!topic });
        const start = Date.now();

        // Fresh set capturing exactly the topics this research agent READ, so
        // they can be merged into the interface's accessed set below.
        const read = new Set<string>();
        // Read-only topic surface: pick list_topics + get_topic out of the full
        // topic toolset (get_topic records into `read`). No create/update means
        // an in-loop body write is structurally impossible.
        const { list_topics, get_topic } = buildTopicTools({
          store,
          accessed: read,
        });
        const tools = {
          list_topics,
          get_topic,
          ...buildWebSearchTool({ search }),
          ...buildReadPageTool({ fetcher }),
        };

        const agentPrompt = topic
          ? `${prompt}\n\nPrior context: the topic "${topic}" already covers this subject. Read it first with get_topic for context.`
          : prompt;

        const { text, finishReason, steps, usage } = await runAgent({
          model,
          system: researchSystemPrompt(),
          prompt: agentPrompt,
          tools,
          maxSteps: RESEARCH_MAX_STEPS,
        });

        // Merge every topic research READ into the interface's accessed set so
        // the writer consolidates them like any other accessed topic. Do not
        // drop this signal just because research no longer writes.
        for (const name of read) accessed.add(name);

        const report = text || "No findings.";
        log("research_completed", {
          steps,
          finish_reason: finishReason,
          duration_ms: Date.now() - start,
          report_len: report.length,
          accessed: [...read],
          ...usageLogFields(usage),
        });

        // The findings report itself is the tool result the interface model
        // reads to answer the user.
        return report;
      },
    }),
  };
};
