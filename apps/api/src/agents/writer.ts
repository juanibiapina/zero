// Writer agent: stateless per turn. Given the accessed topics and the exchange,
// it consolidates durable knowledge into each topic via save_topic. A fallback
// appends a log line to any accessed topic the model skipped, so no exchange is
// lost even if the model declines to call the tool.

import type { LanguageModel } from "ai";
import { buildSaveTopicTool } from "../tools/save-topic";
import type { Topic, TopicStore } from "../store/types";
import { writerSystemPrompt } from "./prompts";
import { runAgent } from "./run";

export interface WriterAgentInput {
  model: LanguageModel;
  store: TopicStore;
  topics: Topic[];
  exchange: { user: string; assistant: string[] };
}

export interface WriterAgentResult {
  saved: string[];
}

export const runWriterAgent = async (
  input: WriterAgentInput,
): Promise<WriterAgentResult> => {
  const { model, store, topics, exchange } = input;
  if (topics.length === 0) return { saved: [] };

  const saved = new Set<string>();
  const tools = buildSaveTopicTool({ store, saved });

  const topicsContext = topics
    .map(
      (t) =>
        `## ${t.name}\nDescription: ${t.description}\nSummary: ${t.summary}\n\n${t.body || "(empty)"}`,
    )
    .join("\n\n---\n\n");
  const exchangeText = `User: ${exchange.user}\n\nAssistant: ${exchange.assistant.join("\n\n")}`;

  await runAgent({
    model,
    system: writerSystemPrompt(),
    prompt: `# Accessed topics\n\n${topicsContext}\n\n# Exchange\n\n${exchangeText}\n\nUpdate each topic as needed.`,
    tools,
  });

  // Fallback: nothing durable should be silently dropped. For any accessed
  // topic the model did not save, append one log line to its body.
  for (const t of topics) {
    if (saved.has(t.name)) continue;
    const current = store.getTopic(t.name);
    if (!current) continue;
    store.updateTopicBody(t.name, appendLog(current.body, logLine(exchange)));
  }

  return { saved: [...saved] };
};

const logLine = (exchange: { user: string }): string => {
  const summary = exchange.user.replace(/\s+/g, " ").slice(0, 120);
  return `- ${new Date().toISOString()} ${summary}`;
};

// Append a line under a "## Log" section, creating the section if absent.
const appendLog = (body: string, line: string): string => {
  if (body.includes("## Log")) {
    return `${body.replace(/\s*$/, "")}\n${line}\n`;
  }
  const base = body.trim();
  return `${base ? `${base}\n\n` : ""}## Log\n${line}\n`;
};
