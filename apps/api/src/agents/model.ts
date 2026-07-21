// LLM adapter (the true-external seam). Both agents get their model here so
// gateway routing and per-user attribution live in one place.
//
// Traffic goes through the Cloudflare AI Gateway (not the raw Anthropic API):
// - `apiKey: ""` is required — @ai-sdk/anthropic throws without an apiKey even
//   though the real Anthropic key is stored in the gateway (BYOK).
// - `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` authenticates to the
//   gateway, which injects the stored Anthropic key upstream.
// - `cf-aig-metadata: {"user_id": clerkUserId, "agent": agent}` reproduces
//   per-user analytics and split-by-value spend limits, and tags which agent
//   (interface / research / writer / onboarding) issued the call so the gateway
//   can break down cost, tokens, and latency per agent. Headers are
//   per-instance, so a fresh provider is built per agent to tag each request.

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Env } from "../types";

// The four agents that issue LLM calls. Each turn runs the interface agent
// (which may spawn research) then the writer; onboarding runs on its own path.
export type AgentLabel = "interface" | "research" | "writer" | "onboarding";

// The `cf-aig-metadata` value. Pure and exported so the exact tag shape is unit
// testable without reaching into an opaque provider instance.
export const gatewayMetadata = (
  clerkUserId: string,
  agent: AgentLabel,
): string => JSON.stringify({ user_id: clerkUserId, agent });

// Resolve the Anthropic base URL: an explicit override (dev/tests) wins,
// otherwise the AI Gateway binding builds it from account + gateway id.
const resolveBaseUrl = async (env: Env): Promise<string> => {
  if (env.LLM_BASE_URL_OVERRIDE) return env.LLM_BASE_URL_OVERRIDE;
  return env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl("anthropic");
};

// Build a per-agent model factory for one user. The base URL is resolved once
// (the only async step); the returned function stamps each model with the
// agent tag. Confined to the DO + orchestrator: agents downstream receive
// concrete tagged models, not this factory.
export const createModelFactory = async (
  env: Env,
  clerkUserId: string,
): Promise<(agent: AgentLabel) => LanguageModel> => {
  const baseURL = await resolveBaseUrl(env);
  return (agent: AgentLabel): LanguageModel => {
    const anthropic = createAnthropic({
      apiKey: "",
      baseURL,
      headers: {
        "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
        "cf-aig-metadata": gatewayMetadata(clerkUserId, agent),
      },
    });
    return anthropic(env.MODEL_ID);
  };
};

// Single-model convenience over the factory, for callers outside a turn (e.g.
// onboarding). Defaults to the interface tag.
export const createModel = async (
  env: Env,
  clerkUserId: string,
  agent: AgentLabel = "interface",
): Promise<LanguageModel> => {
  const makeModel = await createModelFactory(env, clerkUserId);
  return makeModel(agent);
};
