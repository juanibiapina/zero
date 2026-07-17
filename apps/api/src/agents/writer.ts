// Writer agent: stateless per turn, the interface agent's twin. It runs the same
// runAgent machine with the same topic tools (minus reply/research) and is given
// the exchange plus the names of the topics the interface agent accessed. It
// consolidates durable knowledge into those topics and proactively creates a
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
  exchange: { user: string; assistant: string[] };
}

export const runWriterAgent = async (
  input: WriterAgentInput,
): Promise<void> => {
  const { model, store, accessed, exchange } = input;

  const tools = buildTopicTools({ store });

  const exchangeText = `User: ${exchange.user}\n\nAssistant: ${exchange.assistant.join("\n\n")}`;
  const accessedList = accessed.length > 0 ? accessed.join(", ") : "(none)";

  await runAgent({
    model,
    system: writerSystemPrompt(),
    prompt: `# Exchange\n\n${exchangeText}\n\n# Topics accessed this turn\n\n${accessedList}\n\nConsolidate durable knowledge. Use list_topics/get_topic to inspect, update accessed topics that gained facts, and create a topic for any durable subject that has none.`,
    tools,
  });
};
