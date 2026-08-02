import { fmtErr, logError } from "../log";
import type { Env } from "../types";
import type { AgentLabel } from "./model";
import type { AgentRunUsage } from "./protocol";

export interface AiUsageAttribution {
  conversationId?: string;
  chatId?: number;
  topicId?: number;
}

interface ModelPricing {
  version: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWrite5mPerMillion: number;
  cacheWrite1hPerMillion: number;
}

// Standard-tier, short-context list prices. A model missing here records a zero
// cost with `pricingStatus: "unpriced"` rather than failing, so adding a model
// (including a per-agent override) means adding a row here in the same change.
// OpenAI bills one cache tier, so its 1h column is zero and every write lands in
// the 5m bucket (see agents/openai-wire.ts).
const PRICING: Record<string, ModelPricing> = {
  "gpt-5.6-luna": {
    version: "openai-2026-08-02",
    inputPerMillion: 0.2,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.02,
    cacheWrite5mPerMillion: 0.25,
    cacheWrite1hPerMillion: 0,
  },
  "gpt-5.6-terra": {
    version: "openai-2026-08-02",
    inputPerMillion: 2,
    outputPerMillion: 12,
    cacheReadPerMillion: 0.2,
    cacheWrite5mPerMillion: 2.5,
    cacheWrite1hPerMillion: 0,
  },
  "claude-sonnet-4-6": {
    version: "anthropic-2026-07-31",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWrite5mPerMillion: 3.75,
    cacheWrite1hPerMillion: 6,
  },
};

export interface EstimatedUsageCost {
  pricingVersion: string;
  pricingStatus: "priced" | "unpriced";
  estimatedCostUsd: number;
}

export const estimateUsageCost = (
  model: string,
  usage: AgentRunUsage,
): EstimatedUsageCost => {
  const pricing = PRICING[model];
  if (!pricing) {
    return {
      pricingVersion: "unpriced",
      pricingStatus: "unpriced",
      estimatedCostUsd: 0,
    };
  }
  const estimatedCostUsd =
    (usage.inputTokens * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion +
      usage.cacheReadTokens * pricing.cacheReadPerMillion +
      usage.cacheWrite5mTokens * pricing.cacheWrite5mPerMillion +
      usage.cacheWrite1hTokens * pricing.cacheWrite1hPerMillion) /
    1_000_000;
  return {
    pricingVersion: pricing.version,
    pricingStatus: "priced",
    estimatedCostUsd,
  };
};

export const recordAgentUsage = (
  env: Env,
  input: {
    clerkUserId: string;
    model: string;
    agent: AgentLabel;
    attribution?: AiUsageAttribution;
    usage: AgentRunUsage;
  },
): void => {
  const cost = estimateUsageCost(input.model, input.usage);
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
