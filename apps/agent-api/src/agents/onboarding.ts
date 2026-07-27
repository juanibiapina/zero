// Onboarding agent: a one-shot Gmail scan that seeds the pinned identity topic
// when a user connects Google. It is the same runAgent machine as the interface
// and writer agents, given the topic tools plus read-only Gmail (gmail_search,
// gmail_thread) — no reply, no delivery, no research, no web_search, no calendar.
// It authors the pinned topic directly (like the research agent authors its
// topic), so there is no writer pass. Runs off Telegram on the DO alarm.

import type { AgentModel } from "./protocol";
import { buildTopicTools } from "../tools/topics";
import { buildGoogleTools } from "../tools/google";
import type { TopicStore } from "../store/types";
import type { GoogleWorkspace } from "../google/types";
import { onboardingSystemPrompt } from "./prompts";
import { runAgent, usageLogFields } from "./run";
import { log } from "../log";

export interface OnboardingAgentInput {
  model: AgentModel;
  store: TopicStore;
  google: GoogleWorkspace;
  // The pre-created, pinned topic the agent fills (e.g. "User").
  topicName: string;
  // Test override for the step cap; production uses AGENT_MAX_STEPS.
  maxSteps?: number;
}

export const runOnboardingAgent = async (
  input: OnboardingAgentInput,
): Promise<void> => {
  const { model, store, google, topicName } = input;

  // Read-only Gmail: pull just the two read tools out of the Google toolset.
  // Timezone is irrelevant here (no calendar tools are exposed).
  const { gmail_search, gmail_thread } = buildGoogleTools({
    google,
    timezone: "UTC",
  });

  const tools = {
    ...buildTopicTools({ store }),
    gmail_search,
    gmail_thread,
  };

  const start = Date.now();
  const { finishReason, steps, usage } = await runAgent({
    model,
    system: onboardingSystemPrompt(),
    prompt:
      `Scan the user's Gmail to learn who they are, then record durable ` +
      `identity facts (name first) into the topic "${topicName}" with ` +
      `update_topic. The topic already exists and is pinned; fill its body.`,
    tools,
    maxSteps: input.maxSteps,
  });

  log("onboarding_completed", {
    steps,
    finish_reason: finishReason,
    duration_ms: Date.now() - start,
    ...usageLogFields(usage),
  });
};
