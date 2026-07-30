// Test helpers: models that satisfy the AgentModel seam without a network.
// `scriptedModel` plays a fixed script of steps. Each step is either a set of
// tool calls (the loop executes them and continues) or a final text answer
// (which stops the loop). `capturingModel` hands the request to a callback so a
// test can assert on the exact request shape. Not a test file itself.

import type {
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  ContentBlock,
} from "./protocol";

export type ScriptStep =
  // A step that calls tools, optionally saying something first (the model's own
  // text blocks are what the user sees, so a mid-run message is expressed here
  // rather than through a tool).
  | { tools: Array<{ name: string; input: unknown }>; text?: string }
  | { text: string };

let callCounter = 0;

// Canned non-zero usage (with cache details) so tests can assert the token
// counts flow through runAgent's result. No real caching happens here — the
// mock ignores cache_control on the request.
export const MOCK_USAGE = {
  inputTokens: 20,
  outputTokens: 5,
  cacheReadTokens: 8,
  cacheWriteTokens: 4,
};

const toResponse = (step: ScriptStep, index: number): AgentModelResponse => {
  const base = {
    id: `msg_${index}`,
    usage: MOCK_USAGE,
    diagnostic: { state: "initial" as const },
  };
  if (!("tools" in step)) {
    return {
      ...base,
      content: [{ type: "text", text: step.text }],
      stopReason: "end_turn",
    };
  }
  return {
    ...base,
    content: [
      ...(step.text !== undefined
        ? [{ type: "text" as const, text: step.text }]
        : []),
      ...step.tools.map(
      (t): ContentBlock => ({
        type: "tool_use",
        id: `call-${callCounter++}`,
        name: t.name,
        input: t.input,
      })),
    ],
    stopReason: "tool_use",
  };
};

// Build a model that plays the script one step per generate call. End the
// script with a `{ text }` step so the tool loop terminates.
export const scriptedModel = (steps: ScriptStep[]): AgentModel => {
  let index = 0;
  return {
    modelId: "mock-model",
    generate: async () => {
      const step = steps[index];
      if (!step) throw new Error(`scripted model ran out of steps at ${index}`);
      return toResponse(step, index++);
    },
  };
};

// Build a model from a handler over the raw request. Use for request-shape
// assertions (cache breakpoints, system text, tool schemas) and for failure
// injection.
export const capturingModel = (
  handler: (
    request: AgentModelRequest,
  ) => Partial<AgentModelResponse> | Promise<Partial<AgentModelResponse>>,
): AgentModel => ({
  modelId: "mock-model",
  generate: async (request) => {
    const partial = await handler(request);
    return {
      id: "msg_capture",
      content: [{ type: "text", text: "" }],
      stopReason: "end_turn",
      usage: MOCK_USAGE,
      diagnostic: { state: "initial" },
      ...partial,
    };
  },
});
