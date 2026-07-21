// The one agent machine: model + system + prompt + tools + step cap → final
// assistant text. The interface agent and the research agent are the same
// runner instantiated with different system prompts and toolsets. It has no
// opinion about the output (no fallback); callers decide what the text means.

import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { cachedSystemMessage, markLastTool } from "./cache";

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
  // Prompt caching on by default: the system string becomes a cached leading
  // system message and the last tool is marked with a cache breakpoint. Set
  // false to opt out (tests/mocks that assert the plain shape).
  cache?: boolean;
}

// Token counts for one run (aggregate) or one step. `inputTokens` is the
// uncached, full-price input; cache read/write are billed separately by
// Anthropic. See docs/caching.md for how these validate each caching tier.
export interface RunAgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  // Whole-run token totals, summed across every tool-loop step by the AI SDK.
  usage: RunAgentUsage;
  // Per-step token counts. The tier-1 write-then-read pattern (step 1 writes the
  // prefix, later steps read it) is invisible in the aggregate, so callers read
  // this to see it. Empty for a zero-step run.
  stepUsages: RunAgentUsage[];
}

const extractUsage = (usage: LanguageModelUsage): RunAgentUsage => ({
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
});

// Compact log fields for a completion line: token totals plus a single
// cache-hit signal. `cache_hit_ratio` = reads / (reads + writes + uncached
// input); on a multi-step turn the read term counts the prefix once per step,
// so read it as a turn-level signal and use the per-step breakdown for the
// within-run write-then-read check.
export const usageLogFields = (usage: RunAgentUsage) => {
  const denom =
    usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    cache_hit_ratio:
      denom > 0 ? Number((usage.cacheReadTokens / denom).toFixed(3)) : 0,
  };
};

export const runAgent = async (
  input: RunAgentInput,
): Promise<RunAgentResult> => {
  const cache = input.cache ?? true;
  const callerMessages = input.messages ?? [
    { role: "user" as const, content: input.prompt ?? "" },
  ];
  // Cache order is tools -> system -> messages. Mark the last tool (all schemas)
  // and hoist the system string into a cached leading system message; both use
  // a 1h TTL because they are shared across users and stay permanently warm.
  // Any messages-region breakpoints are set by the caller and preserved here.
  const tools =
    cache && input.tools ? markLastTool(input.tools, "1h") : input.tools;
  const messages = cache
    ? [cachedSystemMessage(input.system, "1h"), ...callerMessages]
    : callerMessages;
  const result = await generateText({
    model: input.model,
    ...(cache ? {} : { system: input.system }),
    messages,
    allowSystemInMessages: cache,
    tools,
    stopWhen: stepCountIs(input.maxSteps ?? AGENT_MAX_STEPS),
  });
  return {
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
    messages: result.steps.flatMap((s) => s.response.messages),
    usage: extractUsage(result.usage),
    stepUsages: result.steps.map((s) => extractUsage(s.usage)),
  };
};
