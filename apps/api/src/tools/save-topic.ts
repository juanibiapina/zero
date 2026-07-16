// Writer-agent tool. `save_topic` consolidates the exchange into one topic. The
// `saved` set records which topics the model wrote so the writer can apply a
// fallback log-append to the ones it skipped.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TopicStore } from "../store/types";

export interface SaveTopicDeps {
  store: TopicStore;
  saved: Set<string>;
}

export const buildSaveTopicTool = (deps: SaveTopicDeps): ToolSet => {
  const { store, saved } = deps;

  return {
    save_topic: tool({
      description:
        "Consolidate durable knowledge into a topic. Call once per topic that changed.",
      inputSchema: z.object({
        name: z.string().describe("Current topic name"),
        body: z.string().describe("Full updated topic body (markdown)"),
        description: z.string().describe("Routing description"),
        summary: z.string().describe("Running summary"),
        newName: z.string().optional().describe("New name if renaming"),
      }),
      execute: async ({ name, body, description, summary, newName }) => {
        try {
          store.saveTopic(name, { body, description, summary }, newName);
          saved.add(name);
          if (newName) saved.add(newName);
          return { saved: newName ?? name };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
};
