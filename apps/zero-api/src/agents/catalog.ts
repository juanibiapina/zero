import type { Model } from "@earendil-works/pi-ai";

// pi-ai accepts models outside its static catalog. Rates and limits:
// https://developers.openai.com/api/docs/models/gpt-6-luna
export const GPT_6_LUNA: Model<"openai-responses"> = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  api: "openai-responses",
  provider: "cloudflare-ai-gateway",
  baseUrl:
    "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 272000,
        input: 0.2,
        output: 0.75,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
    ],
  },
  contextWindow: 1050000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true },
};

// Reasoning tokens are billed and counted as output, and at high effort they
// dominate a hard turn, so this ceiling is well above a non-reasoning one.
export const MAX_OUTPUT_TOKENS = 32000;
// Per-attempt request timeout, well inside a DO alarm's patience. Retries are
// bounded so a 429 burst cannot stretch a turn indefinitely.
export const REQUEST_TIMEOUT_MS = 300_000;
export const MAX_RETRIES = 2;
