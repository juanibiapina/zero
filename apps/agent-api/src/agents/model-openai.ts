// OpenAI adapter: the only module that knows the official OpenAI SDK exists.
// Everything Zero-shaped is translated in openai-wire.ts; this module owns the
// network, the gateway auth, and the per-request policy (reasoning effort,
// caching mode, retention of nothing).
//
// Traffic goes through the Cloudflare AI Gateway with a stored OpenAI key
// (BYOK), so:
// - No `Authorization` header goes out. The gateway injects the stored key, and
//   a client-sent one would be used instead. `apiKey` is still a non-null dummy
//   because a null apiKey makes the SDK start its credential-resolution chain,
//   which in workerd believes it is on Node and latches the failure forever.
// - `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` authenticates to the
//   gateway itself.
// - `cf-aig-metadata` carries the user id and the agent tag, so gateway
//   analytics break cost and latency down per user and per agent.

import { OpenAI } from "openai";
import type {
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
} from "./protocol";
import { log } from "../log";
import type { AdapterOptions, AgentLabel } from "./model-options";
import { recordAgentUsage } from "./ai-usage";
import {
  fromWireOutput,
  reasoningTokens,
  toStopReason,
  toUsage,
  toWireInput,
  toWireTools,
  type WireResponse,
} from "./openai-wire";

// Reasoning tokens are billed and counted as output, and at `high` effort they
// dominate a hard turn, so this ceiling is well above the old Anthropic one. A
// rise in `incomplete_details.reason: "max_output_tokens"` is the signal to
// revisit it.
const MAX_OUTPUT_TOKENS = 32000;

// Every agent reasons, interface and background alike. `high` is deliberate and
// load-bearing: the model family defaults to `medium`, and Zero's measured
// quality case for `gpt-5.6-luna` rests on `high` (see
// docs/plans/openai-gpt56-luna.md). `all_turns` is the family default, set
// explicitly so a change of default cannot silently move the cache prefix.
const REASONING = { effort: "high", context: "all_turns" } as const;

// Per-attempt request timeout, well inside a DO alarm's patience. Retries are
// bounded so a 429 burst cannot stretch a turn indefinitely.
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

// Prompt-cache routing key. The static system instructions and the tool schemas
// are byte-identical across users, so the key must be shared for that prefix to
// be reused; it is namespaced per agent because each agent has a different
// prefix, and versioned so a prompt change cannot land on a stale route.
//
// OpenAI asks for roughly <=15 requests/minute per key. `SHARDS` is the lever:
// raising it splits traffic across more keys, each of which caches the shared
// prefix once. Keep the mapping stable so a user keeps hitting the same shard.
const CACHE_KEY_VERSION = "v1";
const SHARDS = 1;

const shardOf = (clerkUserId: string): number => {
  let hash = 0;
  for (let i = 0; i < clerkUserId.length; i++) {
    hash = (hash * 31 + clerkUserId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SHARDS;
};

export const promptCacheKey = (agent: AgentLabel, clerkUserId: string): string =>
  `zero:${agent}:${CACHE_KEY_VERSION}:${shardOf(clerkUserId)}`;

export const createOpenAIModel = (options: AdapterOptions): AgentModel => {
  const { env, clerkUserId, agent, modelId, baseURL, fetchImpl, attribution } =
    options;
  let reportedModelId: string = modelId;
  const client = new OpenAI({
    apiKey: "gateway-byok",
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    defaultHeaders: {
      // Suppress the SDK's own auth header; the gateway supplies the key.
      Authorization: null,
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
      "cf-aig-metadata": options.metadata,
    },
  });
  return {
    modelId,
    generate: async (
      request: AgentModelRequest,
    ): Promise<AgentModelResponse> => {
      const raw = (await client.responses.create({
        model: modelId,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoning: REASONING,
        // Zero's durable log is the source of truth for a conversation, so
        // nothing is stored provider-side and the reasoning items come back
        // encrypted for replay on the next step.
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: promptCacheKey(agent, clerkUserId),
        // Explicit mode: only Zero's own breakpoints are written. The implicit
        // breakpoint would sit on the volatile tail and pay a cache write on
        // every step for bytes no later request can reuse.
        prompt_cache_options: { mode: "explicit" },
        // A stable, opaque per-user identifier, as the safety guidance asks.
        safety_identifier: clerkUserId,
        tools: toWireTools(request.tools),
        input: toWireInput(request.system, request.messages),
        // Cast: the wire types are Zero's own narrow view of the Responses
        // shapes (see openai-wire.ts), which the SDK types far more broadly.
      } as never)) as unknown as WireResponse;

      reportedModelId = (raw as { model?: string }).model ?? modelId;
      const usage = toUsage(raw);
      // Content-free: token counts only, never prompts, responses, or ids. On a
      // working cache, `cache_read_tokens` grows step over step within a run
      // while `input_tokens` stays small.
      log("cache_stats", {
        agent,
        ...(request.step !== undefined ? { step: request.step } : {}),
        input_tokens: usage.inputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        thinking_tokens: reasoningTokens(raw),
      });
      return {
        id: raw.id,
        content: fromWireOutput(raw.output ?? []),
        stopReason: toStopReason(raw),
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
