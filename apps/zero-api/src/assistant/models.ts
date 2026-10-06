import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { cloudflareAIGatewayAuth } from "@earendil-works/pi-ai/providers/cloudflare-auth";
import { cloudflareStreams } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { gatewayMetadata, resolveModelSpec, type AgentLabel } from "../agents/model";
import { GPT_6_LUNA, MAX_OUTPUT_TOKENS } from "../agents/catalog";
import type { Env } from "../types";

export const AGENT_LABELS: readonly AgentLabel[] = [
  "interface",
  "learner",
  "compaction",
  "onboarding",
  "admin_task",
];

export const providerId = (agent: AgentLabel): string =>
  `zero-${agent.replace("_", "-")}`;

const catalog = (): Model<Api>[] => [
  GPT_6_LUNA,
  ...Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
];

const gatewayProvider = (env: Env, clerkUserId: string, agent: AgentLabel) => {
  const id = providerId(agent);
  const headers = { "cf-aig-metadata": gatewayMetadata(clerkUserId, agent) };
  const models = catalog().map(
    (model): Model<Api> => ({
      ...model,
      provider: id,
      headers: { ...(model.headers ?? {}), ...headers },
      maxTokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS),
      ...(env.LLM_BASE_URL_OVERRIDE ? { baseUrl: env.LLM_BASE_URL_OVERRIDE } : {}),
    }),
  );
  return createProvider({
    id,
    name: `Zero ${agent}`,
    auth: { apiKey: cloudflareAIGatewayAuth() },
    models,
    api: {
      "anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
      "openai-completions": cloudflareStreams(openAICompletionsApi()),
      "openai-responses": cloudflareStreams(openAIResponsesApi()),
    },
  });
};

export const createGatewayModels = (env: Env, clerkUserId: string): MutableModels => {
  const values: Record<string, string | undefined> = {
    CLOUDFLARE_API_KEY: env.CLOUDFLARE_API_KEY,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_GATEWAY_ID: env.CLOUDFLARE_GATEWAY_ID,
  };
  const models = createModels({
    authContext: {
      env: async (name) => values[name],
      fileExists: async () => false,
    },
  });
  for (const agent of AGENT_LABELS) {
    models.setProvider(gatewayProvider(env, clerkUserId, agent));
  }
  return models;
};

export interface AgentModelChoice {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
}

export type ModelChoices = (agent: AgentLabel) => AgentModelChoice;

export const gatewayModelChoices =
  (env: Env, clerkUserId: string): ModelChoices =>
  (agent) => {
    const spec = resolveModelSpec(env, { agent, clerkUserId });
    return {
      model: { provider: providerId(agent), modelId: spec.modelId },
      thinkingLevel: spec.effort,
    };
  };
