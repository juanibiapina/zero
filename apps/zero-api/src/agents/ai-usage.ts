import { fmtErr, logError } from "../log";
import type { Env } from "../types";
import type { AgentLabel } from "./model";
import type { AgentRunUsage } from "./protocol";

export interface AiUsageAttribution {
  conversationId?: string;
  chatId?: number;
  topicId?: number;
}

// The cost of a run, taken from the provider layer's own report (pi-ai's
// `usage.cost.total`) rather than a hand-kept price table. `pricingStatus` is
// "unpriced" when the routed model carries no catalog price, so an uncosted
// model still records its tokens instead of a fake zero. `pricingVersion` is a
// catalog sentinel (the model id), because models.dev list prices move silently
// with no stable version string.
export interface EstimatedUsageCost {
  pricingVersion: string;
  pricingStatus: "priced" | "unpriced";
  estimatedCostUsd: number;
}

export const recordAgentUsage = (
  env: Env,
  input: {
    clerkUserId: string;
    model: string;
    agent: AgentLabel;
    attribution?: AiUsageAttribution;
    usage: AgentRunUsage;
    cost: EstimatedUsageCost;
  },
): void => {
  const cost = input.cost;
  const attribution = input.attribution ?? {};
  try {
    env.AI_USAGE.writeDataPoint({
      indexes: [input.clerkUserId],
      blobs: [
        "1",
        input.model,
        input.agent,
        attribution.conversationId ?? "",
        attribution.chatId?.toString() ?? "",
        attribution.topicId?.toString() ?? "",
        cost.pricingVersion,
        cost.pricingStatus,
      ],
      doubles: [
        cost.estimatedCostUsd,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cacheReadTokens,
        input.usage.cacheWrite5mTokens,
        input.usage.cacheWrite1hTokens,
        input.usage.modelCalls,
      ],
    });
  } catch (error) {
    logError("ai_usage_write_failed", {
      agent: input.agent,
      error: fmtErr(error),
    });
  }
};
