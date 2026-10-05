import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { recordAgentUsage } from "./ai-usage";
import type { AgentRunUsage } from "./protocol";

const usage: AgentRunUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 2_000_000,
  cacheWrite5mTokens: 1_000_000,
  cacheWrite1hTokens: 1_000_000,
  costUsd: 28.05,
  modelCalls: 4,
};

describe("AI usage points", () => {
  it("writes the documented positional schema from the provider-reported cost", () => {
    const writeDataPoint = vi.fn();
    const env = { AI_USAGE: { writeDataPoint } } as unknown as Env;

    recordAgentUsage(env, {
      clerkUserId: "user_123",
      model: "claude-sonnet-4.6",
      agent: "interface",
      attribution: { conversationId: "conv_1", chatId: 42, topicId: 7 },
      usage,
      cost: {
        pricingVersion: "claude-sonnet-4.6",
        pricingStatus: "priced",
        estimatedCostUsd: 28.05,
      },
    });

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["user_123"],
      blobs: [
        "1",
        "claude-sonnet-4.6",
        "interface",
        "conv_1",
        "42",
        "7",
        "claude-sonnet-4.6",
        "priced",
      ],
      doubles: [28.05, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 4],
    });
  });

  it("records an unpriced model without a fake zero and does not throw when telemetry fails", () => {
    const env = {
      AI_USAGE: {
        writeDataPoint: () => {
          throw new Error("binding failed");
        },
      },
    } as unknown as Env;

    expect(() =>
      recordAgentUsage(env, {
        clerkUserId: "user_123",
        model: "future-model",
        agent: "onboarding",
        usage,
        cost: {
          pricingVersion: "future-model",
          pricingStatus: "unpriced",
          estimatedCostUsd: 0,
        },
      }),
    ).not.toThrow();
  });
});
