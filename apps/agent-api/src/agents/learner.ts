// The learning agent: consolidates every message since the last consolidation
// into topics, and summarizes a conversation that has grown too large.
//
// It is the same `runAgent` machine as every other agent, with two differences
// that come from running in LearningDO instead of on the turn path:
//
// 1. Its store is the async learning port, so its topic tools reach UserDO over
//    RPC. Same tools, same expected-version contract.
// 2. It runs in **bounded slices**. A Durable Object alarm is killed at 900s
//    wall time with no exception and no log, so a job advances a few model steps
//    per alarm, persists what it produced, and re-arms while unfinished. The
//    persisted wire log is what the next slice resumes from — including a
//    response whose tools never ran, which `runAgent` repairs by running them.

import { buildTopicTools } from "../tools/topics";
import { compactionSystemPrompt, learnerSystemPrompt } from "./prompts";
import { runAgent, type RunAgentUsage } from "./run";
import type { AgentMessage, AgentModel, ContentBlock, StopReason, ToolResultBlock } from "./protocol";
import { messageText } from "../store/messages";
import type { LearningMessage } from "../store/types";
import type { LearningPort } from "../learning/types";

// Model steps per alarm slice. Small enough that a slice cannot approach the
// 900s ceiling, large enough that an ordinary consolidation finishes in one.
export const LEARN_STEPS_PER_SLICE = 12;

// Cap on one tool result inside the rendered raw log. The learner reads real
// messages, and a research report or a calendar dump would otherwise dominate
// its input.
const MAX_RENDERED_RESULT_CHARS = 2000;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

const renderBlocks = (blocks: ContentBlock[]): string[] =>
  blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use")
      return `[called ${block.name}]`;
    if (block.type === "tool_result") {
      const content =
        typeof block.content === "string"
          ? block.content
          : block.content
              .map((b) => (b.type === "text" ? b.text : "[image]"))
              .join("\n");
      return `[tool result] ${truncate(content, MAX_RENDERED_RESULT_CHARS)}`;
    }
    return "[image]";
  });

// Render the raw log for the prompt: grouped by conversation, in id order, with
// tool calls and results kept (that is where facts the user never restated live)
// but bounded.
export const renderLearningLog = (messages: LearningMessage[]): string => {
  const byConversation = new Map<string, LearningMessage[]>();
  for (const message of messages) {
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  const sections: string[] = [];
  let index = 0;
  for (const [, rows] of byConversation) {
    index++;
    const lines = rows.map((row) => {
      const who = row.role === "user" ? "User" : "Assistant";
      const body =
        typeof row.content === "string"
          ? row.content
          : renderBlocks(row.content).join("\n");
      return `${who}: ${body}`;
    });
    sections.push(`## Conversation ${index}\n\n${lines.join("\n\n")}`);
  }
  return sections.join("\n\n");
};

export interface LearnerSliceInput {
  model: AgentModel;
  port: LearningPort;
  // The raw messages this job covers, frozen when it began.
  messages: LearningMessage[];
  // What earlier slices of this same job already produced: the learner's own
  // responses and tool results. Empty on the first slice.
  wireLog: AgentMessage[];
  maxSteps?: number;
  // Persist one response before its tools run, and its results before the next
  // model call. Same rule as a turn: never lose what already happened.
  onAssistant?: (
    content: ContentBlock[],
    stopReason: StopReason | null,
  ) => Promise<void>;
  onToolResults?: (results: ToolResultBlock[]) => Promise<void>;
}

export interface LearnerSliceResult {
  // False when the slice hit its step bound with work outstanding: the caller
  // re-arms its alarm and calls again.
  finished: boolean;
  steps: number;
  usage: RunAgentUsage;
}

export const runLearnerSlice = async (
  input: LearnerSliceInput,
): Promise<LearnerSliceResult> => {
  const tools = buildTopicTools({ store: input.port.topics });
  const prompt = `# Messages since the last consolidation\n\n${renderLearningLog(
    input.messages,
  )}\n\nConsolidate the durable knowledge in these messages into topics.`;

  const { finishReason, steps, usage } = await runAgent({
    model: input.model,
    system: learnerSystemPrompt(),
    messages: [{ role: "user", content: prompt }, ...input.wireLog],
    tools,
    maxSteps: input.maxSteps ?? LEARN_STEPS_PER_SLICE,
    onAssistant: async (content, stopReason) => {
      await input.onAssistant?.(content, stopReason);
      return null;
    },
    onToolResults: async (results) => input.onToolResults?.(results),
  });

  return { finished: finishReason === "stop", steps, usage };
};

export interface CompactionInput {
  model: AgentModel;
  // The conversation as the model currently sees it: the previous summary (if
  // any) and the messages after the boundary.
  summary: string | null;
  messages: LearningMessage[];
}

// Summarize a conversation's history into the prose that replaces it. One model
// call, no tools: the summary must not be able to read a topic, because anything
// it copied in would become an unversioned snapshot nothing can invalidate.
export const summarizeConversation = async (
  input: CompactionInput,
): Promise<{ summary: string; usage: RunAgentUsage }> => {
  const previous = input.summary
    ? `# Summary of the conversation so far\n\n${input.summary}\n\n`
    : "";
  const body = input.messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m.content)}`)
    .filter((line) => line.trim() !== "")
    .join("\n\n");

  const { text, usage } = await runAgent({
    model: input.model,
    system: compactionSystemPrompt(),
    prompt: `${previous}# Conversation\n\n${body}\n\nWrite the summary.`,
  });
  return { summary: text.trim(), usage };
};
