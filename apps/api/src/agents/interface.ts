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

  // A send failure inside the `reply` tool is swallowed by the AI SDK (a thrown
  // tool execute becomes a tool-error fed back to the model, not a rejected
  // generateText). Capture the first failure here and re-raise it after the
  // loop so it reaches the orchestrator's error boundary (turn_failed +
  // fallback). Short-circuit after the first failure so a fully-broken
  // transport is not hammered by repeated model retries within the step cap.
  let firstSendError: Error | null = null;
  const recordingSend = async (text: string): Promise<void> => {
    if (firstSendError !== null) throw firstSendError;
    try {
      await input.send(text);
    } catch (err) {
      firstSendError = err instanceof Error ? err : new Error(String(err));
      throw firstSendError;
    }
  };

  const tools = {
    ...buildInterfaceTools({
      store: input.store,
      send: recordingSend,
      persistReply,
      accessed,
      replies,
    }),
    ...buildResearchTool({
      model: input.model,
      store: input.store,
      search: input.search,
      accessed,
    }),
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

  // A `reply` send failed and the AI SDK swallowed it. Re-raise so the
  // orchestrator's error boundary logs turn_failed and delivers the fallback.
  // The undelivered reply row was already persisted (persist-before-send), so
  // it stays in history alongside the fallback — the same "partial turn"
  // tradeoff as a mid-run eviction (see docs/topics.md), now visible not silent.
  if (firstSendError !== null) throw firstSendError as Error;

  const lastReply = replies[replies.length - 1]?.trim();

  // Clean finish: the model's final message is the substantive answer, so
  // deliver it — unless it is empty or an exact echo of the reply we already
  // sent. The model routinely puts the answer in its final text rather than a
  // reply() call, notably after a research tool call that followed an
  // acknowledgement reply. Earlier logic suppressed this whenever ANY reply had
  // gone out (even a bare "Searching now..." ack), which silently dropped the
  // real answer. Always sending the final message keeps ack-then-answer intact;
  // the echo guard prevents re-sending text the model already delivered.
  if (finishReason === "stop" && text.trim() && text.trim() !== lastReply) {
    persistReply(text);
    await input.send(text);
    replies.push(text);
    return { replies, accessed: [...accessed] };
  }

  // Cap cut-off (finishReason !== "stop"), or a clean finish that produced no
  // final message and never sent a reply: the model never produced its intended
  // answer. Send a fallback so the user is never left in silence. (A clean
  // finish that already sent a reply and ended with empty/echo text needs no
  // fallback — the reply was the answer.)
  if (finishReason !== "stop" || replies.length === 0) {
    log("turn_incomplete", { finish_reason: finishReason, steps });
    persistReply(FALLBACK_MESSAGE);
    await input.send(FALLBACK_MESSAGE);
    replies.push(FALLBACK_MESSAGE);
  }

  return { replies, accessed: [...accessed] };
};

export type { TopicStore };
