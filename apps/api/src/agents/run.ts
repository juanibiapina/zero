// The one agent machine: model + system + prompt + tools + step cap → final
// assistant text. The interface agent and the research agent are the same
// runner instantiated with different system prompts and toolsets. It has no
// opinion about the output (no fallback); callers decide what the text means.

import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";

export interface RunAgentInput {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools?: ToolSet;
  maxSteps?: number;
}

export const runAgent = async (input: RunAgentInput): Promise<string> => {
  const result = await generateText({
    model: input.model,
    system: input.system,
    messages: [{ role: "user", content: input.prompt }],
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps ?? 10),
  });
  return result.text;
};
