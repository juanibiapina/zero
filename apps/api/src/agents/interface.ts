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

export const CONVERSATION_HEADER =
  'Here is the conversation so far. Lines beginning "User:" are from the ' +
  'user; lines beginning "You:" are your own earlier replies. Respond to the ' +
  "latest user message.";

export const renderConversation = (
  history: Message[],
  userMessage: string,
): string => {
  const turns = [...history, { role: "user" as const, content: userMessage }];
  const body = turns
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`)
    .join("\n\n");
  return `${CONVERSATION_HEADER}\n\n${body}`;
};

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

  const prompt = renderConversation(input.history, input.userMessage);
  await generateText({
    model: input.model,
    system: interfaceSystemPrompt(),
    messages: [{ role: "user", content: prompt }],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  return { replies, accessed: [...accessed] };
};

export type { TopicStore };
