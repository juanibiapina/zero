// The one agent machine: model + system + prompt + tools + step cap → final
// assistant text. The interface agent and the research agent are the same
// runner instantiated with different system prompts and toolsets. It has no
// opinion about the output (no fallback); callers decide what the text means.

import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

// Shared step cap for every agent (interface and research). The cap is a
// runaway-loop guard, not an expected stopping point: the model normally
// finishes in a handful of steps. 200 gives generous headroom (AI SDK's own
// default is 20) while still bounding pathological loops.
//
// Tradeoff of a high cap: (a) the Cloudflare subrequest ceiling — 1000
// subrequests per invocation; each step is >=1 LLM call, research adds search
// calls, and interface x research nest multiplicatively — and (b) longer
// wall-clock time, which widens the window for mid-run DO eviction. 200 is a
// safety net; if runaway loops show up in logs (finish_reason != "stop" with a
// high step count), lower it.
export const AGENT_MAX_STEPS = 200;

export interface RunAgentInput {
  model: LanguageModel;
  system: string;
  // Either a single user `prompt` string (wrapped into one user message) or a
  // full `messages` array. The interface agent passes structured `messages`
  // (native user/assistant turns); research, writer, and onboarding pass a
  // `prompt`. When both are present, `messages` wins.
  prompt?: string;
  messages?: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}

export interface RunAgentResult {
  text: string;
  // "stop" means the model produced a final answer; anything else (notably
  // "tool-calls") means the loop was cut off before a final answer — callers
  // use this to detect cap exhaustion and deliver a fallback.
  finishReason: string;
  steps: number;
  // The assistant + tool messages generated across every step this run (tool
  // calls, tool results, assistant text). Callers serialize these into a turn
  // transcript so a downstream agent sees what tools returned, not only the
  // final text. `response.messages` alone holds only the last step, so this
  // flattens all steps.
  messages: ModelMessage[];
}

export const runAgent = async (
  input: RunAgentInput,
): Promise<RunAgentResult> => {
  const messages = input.messages ?? [
    { role: "user" as const, content: input.prompt ?? "" },
  ];
  const result = await generateText({
    model: input.model,
    system: input.system,
    messages,
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps ?? AGENT_MAX_STEPS),
  });
  return {
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
    messages: result.steps.flatMap((s) => s.response.messages),
  };
};
