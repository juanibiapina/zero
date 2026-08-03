// Anthropic adapter: the only module that knows the official Anthropic SDK
// exists. Kept alongside the OpenAI adapter so `MODEL_ID` alone decides which
// provider a deploy runs on, and a rollback needs no code change (see
// docs/plans/openai-gpt56-luna.md). Delete it once the OpenAI path has run
// clean for a while.
//
// Traffic goes through the Cloudflare AI Gateway (not the raw Anthropic API):
// - `x-api-key` is deliberately suppressed (`defaultHeaders: { "x-api-key":
//   null }`). Under BYOK the gateway injects the stored Anthropic key, and a
//   client-sent key would override it. `apiKey` is still a non-null dummy:
//   with a null apiKey the SDK starts its credential-resolution chain, which in
//   workerd believes it is on Node and latches any resolution error into the
//   client forever.
// - `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` authenticates to the
//   gateway, which injects the stored provider key upstream.
// - `cf-aig-metadata` reproduces per-user analytics and tags the agent.

import { Anthropic } from "@anthropic-ai/sdk/client";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";
import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  CacheControl,
  CacheTtl,
  ContentBlock,
  TextBlock,
  TokenUsage,
} from "./protocol";
import { log } from "../log";
import type { AdapterOptions } from "./model-options";
import { recordAgentUsage } from "./ai-usage";

// Required by the API. With an explicit client `timeout` the SDK stops deriving
// its own non-streaming ceiling, so this is a product choice: far above any
// reply or topic body Zero has ever produced, low enough that a runaway
// generation is bounded. Thinking counts against it, so a rise in
// `stop_reason: max_tokens` is the signal to revisit this number.
const MAX_TOKENS = 16000;

// Every agent thinks, interface and background alike. Thinking is off on Sonnet
// 4.6 unless asked for, and `effort` is deliberately NOT set: omitting it is the
// API's `high`. `display: "omitted"` keeps the signature needed to round-trip a
// thinking block through the tool loop while storing no reasoning prose.
const THINKING = { type: "adaptive", display: "omitted" } as const;

// Per-attempt request timeout. The SDK default is 600s, an unhelpfully long
// abort inside a DO alarm. Retries are bounded too, so a 429 burst cannot
// stretch a turn indefinitely.
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

// Anthropic's two provider-specific caching rules, which the shared cache
// policy (agents/cache.ts) deliberately does not know about:
//
// - A request may carry at most 4 blocks with `cache_control`; a fifth is a
//   400. The shared policy marks every markable message, so the marks are
//   trimmed here to the last ones that fit under the system region's share.
// - TTL is per breakpoint. The system region is the long-lived, high-reuse
//   prefix, so it takes 1h; the message region churns and takes the 5m default.
const MAX_BREAKPOINTS = 4;

type Marked = { cache_control?: CacheControl };

const isMarked = (block: ContentBlock): boolean =>
  !!(block as Marked).cache_control;

const withTtl = <T extends ContentBlock | TextBlock>(
  block: T,
  ttl: CacheTtl,
): T => {
  const control = (block as Marked).cache_control;
  return control ? { ...block, cache_control: { ...control, ttl } } : block;
};

const unmark = (block: ContentBlock): ContentBlock => {
  if (!isMarked(block)) return block;
  const { cache_control: _dropped, ...rest } = block as ContentBlock & Marked;
  return rest;
};

// Keep the last `budget` marks in the message region and strip the rest.
// Trimming from the front rather than the back keeps the newest, growing prefix
// cached, which is where the within-run reads come from.
const trimMessageBreakpoints = (
  messages: AgentMessage[],
  budget: number,
): AgentMessage[] => {
  const marked: number[] = [];
  messages.forEach((message, index) => {
    if (Array.isArray(message.content) && message.content.some(isMarked))
      marked.push(index);
  });
  const drop = new Set(marked.slice(0, Math.max(marked.length - budget, 0)));
  return messages.map((message, index) => {
    if (!Array.isArray(message.content)) return message;
    if (drop.has(index))
      return { ...message, content: message.content.map(unmark) };
    return { ...message, content: message.content.map((b) => withTtl(b, "5m")) };
  });
};

const toUsage = (usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  } | null;
}): TokenUsage => ({
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  cacheWrite5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
  cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
});

export const createAnthropicModel = (options: AdapterOptions): AgentModel => {
  const { env, clerkUserId, agent, modelId, baseURL, fetchImpl, attribution } =
    options;
  let reportedModelId: string = modelId;
  const client = new Anthropic({
    apiKey: "gateway-byok",
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    defaultHeaders: {
      // Suppress the SDK's own auth header; the gateway supplies the key.
      "x-api-key": null,
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
      "cf-aig-metadata": options.metadata,
    },
  });
  return {
    modelId,
    generate: async (
      request: AgentModelRequest,
    ): Promise<AgentModelResponse> => {
      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: MAX_TOKENS,
        system: request.system.map((block) => withTtl(block, "1h")),
        tools: request.tools,
        // Cast: the protocol types an image block's media type as a plain
        // string (attachment MIME types come from Telegram at runtime), while
        // the SDK narrows it to the four types the API accepts. An unsupported
        // type is rejected upstream, not here.
        messages: trimMessageBreakpoints(
          request.messages,
          MAX_BREAKPOINTS - request.system.filter(isMarked).length,
        ) as BetaMessageParam[],
        thinking: THINKING,
      });
      reportedModelId = response.model;
      const usage = toUsage(response.usage);
      // Content-free: token counts only, never prompts, responses, or ids.
      log("cache_stats", {
        agent,
        ...(request.step !== undefined ? { step: request.step } : {}),
        input_tokens: usage.inputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        thinking_tokens:
          response.usage.output_tokens_details?.thinking_tokens ?? 0,
      });
      return {
        id: response.id,
        content: response.content as unknown as ContentBlock[],
        stopReason: response.stop_reason,
        usage,
      };
    },
    reportRunUsage: (usage) =>
      recordAgentUsage(env, {
        clerkUserId,
        model: reportedModelId,
        agent,
        attribution,
        usage,
      }),
  };
};
