// Writer agent: stateless per turn, the interface agent's twin. It runs the same
// runAgent machine with the same topic tools (minus reply/research) and is given
// the turn transcript plus the names of the topics the interface agent accessed.
// It consolidates durable knowledge into those topics and proactively creates a
// topic for any durable subject that has none. Skips trivial turns by making no
// tool call. The store is the observable surface, so it returns nothing.

import type { LanguageModel } from "ai";
import { buildTopicTools } from "../tools/topics";
import type { TopicStore } from "../store/types";
import { writerSystemPrompt } from "./prompts";
import { runAgent } from "./run";

export interface WriterAgentInput {
  model: LanguageModel;
  store: TopicStore;
  accessed: string[];
  // The interface agent's turn transcript: user message, tool calls and their
  // results, and assistant replies. Richer than the replies alone, so durable
  // facts learned through tools are visible to consolidate.
  transcript: string;
}

export const runWriterAgent = async (
  input: WriterAgentInput,
): Promise<void> => {
  const { model, store, accessed, transcript } = input;

  const tools = buildTopicTools({ store });

  const accessedList = accessed.length > 0 ? accessed.join(", ") : "(none)";

  await runAgent({
    model,
    system: writerSystemPrompt(),
    prompt: `# Turn transcript\n\n${transcript}\n\n# Topics accessed this turn\n\n${accessedList}\n\nConsolidate durable knowledge. Use list_topics/get_topic to inspect, update accessed topics that gained facts, and create a topic for any durable subject that has none.`,
    tools,
  });
};
