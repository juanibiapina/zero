// Interface agent: stateless per turn. Runs the tool loop, sends replies as it
// goes, and reports which topics it touched so the writer can consolidate them.
// The returned { replies, accessed } is the test surface for the whole system.

import { generateText, stepCountIs, type LanguageModel } from "ai";
import { buildInterfaceTools } from "../tools/topics";
import type { Message, TopicStore } from "../store/types";
import { interfaceSystemPrompt } from "./prompts";

const MAX_STEPS = 10;

export interface InterfaceAgentInput {
  model: LanguageModel;
  store: TopicStore;
  send: (text: string) => Promise<void>;
  history: Message[];
  userMessage: string;
}

export interface InterfaceAgentResult {
  replies: string[];
  accessed: string[];
}

export const runInterfaceAgent = async (
  input: InterfaceAgentInput,
): Promise<InterfaceAgentResult> => {
  const accessed = new Set<string>();
  const replies: string[] = [];

  const tools = buildInterfaceTools({
    store: input.store,
    send: input.send,
    accessed,
    replies,
  });

  await generateText({
    model: input.model,
    system: interfaceSystemPrompt(),
    messages: [
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input.userMessage },
    ],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  return { replies, accessed: [...accessed] };
};

export type { TopicStore };
