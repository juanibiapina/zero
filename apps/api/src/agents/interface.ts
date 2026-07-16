// Interface agent: stateless per turn. Runs the tool loop, sends replies as it
// goes, and reports which topics it touched so the writer can consolidate them.
// The returned { replies, accessed } is the test surface for the whole system.

import { type LanguageModel } from "ai";
import { buildInterfaceTools } from "../tools/topics";
import { buildResearchTool } from "../tools/research";
import type { Message, TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";
import { interfaceSystemPrompt } from "./prompts";
import { runAgent } from "./run";
import { log } from "../log";

// Delivered when the model never produces its intended answer (loop hit the
// step cap mid-tool-call, or finished clean with nothing to say). Named so
// tests can assert on it. Short, honest, no internal jargon.
export const FALLBACK_MESSAGE =
  "Sorry, I couldn't finish that one. Could you try again?";

export interface InterfaceAgentInput {
  model: LanguageModel;
  store: TopicStore;
  send: (text: string) => Promise<void>;
  // Persist an assistant message durably before it is sent. Wired by the
  // orchestrator to the message store; defaults to a no-op in tests that only
  // assert on send/replies. Persist-before-send keeps retries idempotent.
  persistReply?: (text: string) => void;
  history: Message[];
  userMessage: string;
  search: WebSearch;
  // Test override for the step cap; production uses AGENT_MAX_STEPS.
  maxSteps?: number;
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
  const persistReply = input.persistReply ?? (() => {});

  const tools = {
    ...buildInterfaceTools({
      store: input.store,
      send: input.send,
      persistReply,
      accessed,
      replies,
    }),
    ...buildResearchTool({ model: input.model, search: input.search }),
  };

  // The agent's replies are the { replies, accessed } collected by the tool
  // closures above. The runner's returned text is the model's final prose.
  const start = Date.now();
  const { text, finishReason, steps } = await runAgent({
    model: input.model,
    system: interfaceSystemPrompt(),
    prompt: renderConversation(input.history, input.userMessage),
    tools,
    maxSteps: input.maxSteps,
  });

  log("interface_completed", {
    steps,
    finish_reason: finishReason,
    replies_count: replies.length,
    accessed_count: accessed.size,
    duration_ms: Date.now() - start,
  });

  const delivered = replies.length > 0;

  // Clean finish with prose but no reply(): deliver that text so the turn is
  // never silently dropped. Guarded on no prior reply so trailing filler (e.g.
  // "done") after real replies is not sent.
  if (finishReason === "stop" && !delivered && text.trim()) {
    persistReply(text);
    await input.send(text);
    replies.push(text);
    return { replies, accessed: [...accessed] };
  }

  // Cap cut-off (finishReason !== "stop"), or a clean finish that delivered
  // nothing: the model never produced its intended answer. Send a fallback so
  // the user is never left in silence, even if an ack reply() already went out
  // (the real answer never arrived). Record it in replies so it is persisted
  // and the thread stops awaiting reply.
  if (finishReason !== "stop" || !delivered) {
    log("turn_incomplete", { finish_reason: finishReason, steps });
    persistReply(FALLBACK_MESSAGE);
    await input.send(FALLBACK_MESSAGE);
    replies.push(FALLBACK_MESSAGE);
  }

  return { replies, accessed: [...accessed] };
};

export type { TopicStore };
