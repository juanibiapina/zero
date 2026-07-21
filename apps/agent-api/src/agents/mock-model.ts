// Test helper: build a MockLanguageModelV3 from a script of steps. Each step is
// either a set of tool calls (the loop will execute them and continue) or a
// final text answer (which stops the loop). Not a test file itself.

import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

export type ScriptStep =
  | { tools: Array<{ name: string; input: unknown }> }
  | { text: string };

let callCounter = 0;

// The V3 language-model spec models finishReason as { unified, raw }, not a
// bare string; downstream code reads `.unified`, so the mock must match.
const finishReason = (unified: string) => ({ unified, raw: unified });

const toResult = (step: ScriptStep): LanguageModelV3GenerateResult => {
  if ("text" in step) {
    return {
      content: [{ type: "text", text: step.text }],
      finishReason: finishReason("stop"),
      usage: { inputTokens: {}, outputTokens: {} },
      warnings: [],
    } as unknown as LanguageModelV3GenerateResult;
  }
  return {
    content: step.tools.map((t) => ({
      type: "tool-call",
      toolCallId: `call-${callCounter++}`,
      toolName: t.name,
      input: JSON.stringify(t.input),
    })),
    finishReason: finishReason("tool-calls"),
    usage: { inputTokens: {}, outputTokens: {} },
    warnings: [],
  } as unknown as LanguageModelV3GenerateResult;
};

// Build a model that plays the script one step per generate call. End the
// script with a `{ text }` step so the tool loop terminates.
export const scriptedModel = (steps: ScriptStep[]): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: steps.map(toResult),
  });
