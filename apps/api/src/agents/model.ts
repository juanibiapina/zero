// LLM adapter (the true-external seam). Both agents get their model here so
// gateway routing and per-user attribution live in one place.
//
// Traffic goes through the Cloudflare AI Gateway (not the raw Anthropic API):
// - `apiKey: ""` is required — @ai-sdk/anthropic throws without an apiKey even
//   though the real Anthropic key is stored in the gateway (BYOK).
// - `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` authenticates to the
//   gateway, which injects the stored Anthropic key upstream.
// - `cf-aig-metadata: {"user_id": clerkUserId}` reproduces per-user analytics
//   and split-by-value spend limits. Headers are per-instance, so a fresh
//   provider is built per turn to tag each user.

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Env } from "../types";

// Resolve the Anthropic base URL: an explicit override (dev/tests) wins,
// otherwise the AI Gateway binding builds it from account + gateway id.
const resolveBaseUrl = async (env: Env): Promise<string> => {
  if (env.LLM_BASE_URL_OVERRIDE) return env.LLM_BASE_URL_OVERRIDE;
  return env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl("anthropic");
};

export const createModel = async (
  env: Env,
  clerkUserId: string,
): Promise<LanguageModel> => {
  const anthropic = createAnthropic({
    apiKey: "",
    baseURL: await resolveBaseUrl(env),
    headers: {
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
      "cf-aig-metadata": JSON.stringify({ user_id: clerkUserId }),
    },
  });
  return anthropic(env.MODEL_ID);
};
