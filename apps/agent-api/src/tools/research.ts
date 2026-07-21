// Research tool for the interface agent. Calling it spawns a research-prompted
// agent (the same runner) armed with the topic tools + a web_search tool; that
// agent reads related topics for context, investigates with web search, and
// writes its findings directly to a topic (new or existing). Writing findings at
// the source keeps references verbatim — no intermediary retells them. The tool
// always returns a topic: if the agent finished without writing one, it creates
// a fallback topic from the prompt with the agent's final text as the body.
// Reuses the interface agent's model instance so per-user gateway attribution is
// preserved.

import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent, usageLogFields } from "../agents/run";
import { researchSystemPrompt } from "../agents/prompts";
import { buildTopicTools } from "./topics";
import { buildWebSearchTool } from "./web-search";
import { log } from "../log";
import type { TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";

export interface ResearchToolDeps {
  model: LanguageModel;
  store: TopicStore;
  search: WebSearch;
  // The interface agent's accessed set. Topics the research agent writes are
  // merged in so the writer consolidates them like any other accessed topic.
  accessed: Set<string>;
}

// Derive a topic name from the research prompt for the fallback path. Keep it
// short and stable; the writer can rename it later.
const fallbackTopicName = (prompt: string): string => {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
};

export const buildResearchTool = (deps: ResearchToolDeps): ToolSet => {
  const { model, store, search, accessed } = deps;

  return {
    research: tool({
      description:
        "Research a subject using web search and record the findings in a topic. " +
        "Use proactively whenever the user mentions a researchable subject (a " +
        "company, product, technology, person, place, or event) or makes a claim " +
        "worth checking — not only for explicit questions. It reads and writes " +
        "topics, so if the subject already has a topic, pass its name as `topic` " +
        "so the agent builds on it. Adds latency, so acknowledge the user with " +
        "reply first. Returns the topic it recorded findings in plus a sourced " +
        "summary.",
      inputSchema: z.object({
        prompt: z.string(),
        topic: z.string().optional(),
      }),
      execute: async ({ prompt, topic }) => {
        log("research_started", { prompt_len: prompt.length, has_topic: !!topic });
        const start = Date.now();

        // Fresh set capturing exactly the topics this research agent touched.
        const written = new Set<string>();
        const tools = {
          ...buildTopicTools({ store, accessed: written }),
          ...buildWebSearchTool({ search }),
        };

        const agentPrompt = topic
          ? `${prompt}\n\nPrior context: the topic "${topic}" already covers this subject. Read it first with get_topic and update it with your findings.`
          : prompt;

        const { text, finishReason, steps, usage } = await runAgent({
          model,
          system: researchSystemPrompt(),
          prompt: agentPrompt,
          tools,
        });

        // Safety net mirroring the interface's no-silence fallback: guarantee a
        // topic is always returned even if the agent forgot to write one.
        if (written.size === 0) {
          const name = fallbackTopicName(prompt);
          if (!store.getTopic(name)) store.createTopic(name, prompt);
          store.updateTopicBody(name, text || "No findings.");
          written.add(name);
        }

        // Merge written topics into the interface's accessed set so the writer
        // sees them and consolidates them.
        for (const name of written) accessed.add(name);

        const names = [...written];
        log("research_completed", {
          steps,
          finish_reason: finishReason,
          duration_ms: Date.now() - start,
          result_len: text.length,
          topics: names,
          ...usageLogFields(usage),
        });

        const handle =
          names.length === 1
            ? `Saved to topic '${names[0]}'.`
            : `Saved to topics: ${names.map((n) => `'${n}'`).join(", ")}.`;
        return `${handle}\n\n${text || "No findings."}`;
      },
    }),
  };
};
