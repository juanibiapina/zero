// Generic agent for administrator-invoked work. It receives the task prompt
// verbatim and can operate only on the user's durable knowledge model.

import type { AgentModel } from "./protocol";
import { log } from "../log";
import type { TopicStore } from "../store/types";
import { buildTopicTools } from "../tools/topics";
import { adminTaskSystemPrompt } from "./prompts";
import { runAgent, usageLogFields } from "./run";

export interface AdminTaskAgentInput {
  model: AgentModel;
  store: TopicStore;
  prompt: string;
  maxSteps?: number;
}

export const runAdminTaskAgent = async (
  input: AdminTaskAgentInput,
): Promise<string> => {
  const start = Date.now();
  const { text, finishReason, steps, usage } = await runAgent({
    model: input.model,
    system: adminTaskSystemPrompt(),
    prompt: input.prompt,
    tools: buildTopicTools({ store: input.store }),
    maxSteps: input.maxSteps,
  });

  log("admin_task_completed", {
    steps,
    finish_reason: finishReason,
    duration_ms: Date.now() - start,
    ...usageLogFields(usage),
  });

  if (finishReason !== "stop") {
    throw new Error(`admin task stopped with finish reason: ${finishReason}`);
  }
  return text;
};
