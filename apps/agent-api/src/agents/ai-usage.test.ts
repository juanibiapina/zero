import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { estimateUsageCost, recordAgentUsage } from "./ai-usage";
import type { AgentRunUsage } from "./protocol";

const usage: AgentRunUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 2_000_000,
  cacheWrite5mTokens: 1_000_000,
  cacheWrite1hTokens: 1_000_000,
  modelCalls: 4,
};

describe("AI usage pricing", () => {
  it("prices every Sonnet 4.6 token category", () => {
    expect(estimateUsageCost("claude-sonnet-4-6", usage)).toEqual({
      pricingVersion: "anthropic-2026-07-31",
      pricingStatus: "priced",
      estimatedCostUsd: 28.05,
    });
  });

  it("keeps unknown models visibly unpriced", () => {
    expect(estimateUsageCost("future-model", usage)).toEqual({
      pricingVersion: "unpriced",
      pricingStatus: "unpriced",
      estimatedCostUsd: 0,
    });
  });
});

describe("AI usage points", () => {
  it("writes the documented positional schema with chat attribution", () => {
    const writeDataPoint = vi.fn();
    const env = { AI_USAGE: { writeDataPoint } } as unknown as Env;

    recordAgentUsage(env, {
      clerkUserId: "user_123",
      model: "claude-sonnet-4-6",
      agent: "interface",
      attribution: { conversationId: "conv_1", chatId: 42, topicId: 7 },
      usage,
    });

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["user_123"],
      blobs: [
        "1",
        "claude-sonnet-4-6",
        "interface",
        "conv_1",
        "42",
        "7",
        "anthropic-2026-07-31",
        "priced",
      ],
      doubles: [28.05, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 4],
    });
  });

  it("uses empty sentinels and does not throw when telemetry fails", () => {
    const env = {
      AI_USAGE: { writeDataPoint: () => { throw new Error("binding failed"); } },
    } as unknown as Env;

    expect(() =>
      recordAgentUsage(env, {
        clerkUserId: "user_123",
        model: "future-model",
        agent: "onboarding",
        usage,
      }),
    ).not.toThrow();
  });
});
