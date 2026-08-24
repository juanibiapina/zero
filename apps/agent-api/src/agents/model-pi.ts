// The one adapter that knows @earendil-works/pi-ai exists. It implements the
// dependency-free `AgentModel` seam (protocol.ts) by translating Zero's
// Anthropic-wire request/response shapes to and from pi-ai's `Context` /
// `AssistantMessage`, and hands the transport to pi-ai's built-in
// `cloudflare-ai-gateway` provider.
//
// The provider already does the whole BYOK transport Zero used to hand-roll:
// `cf-aig-authorization: Bearer <key>`, `Authorization`/`x-api-key` suppression,
// gateway base-URL templating from the account + gateway id, and routing to the
// Responses vs Messages wire by the model's own `api`. Zero adds only two
// things: the per-user `cf-aig-metadata` header (via `transformHeaders`, which
// pi-ai runs last) and the per-request `env` so auth and the URL template
// resolve from the Worker binding instead of ambient process env.
//
// The trickiest translation is reasoning. Zero persists a `thinking` block per
// provider shape: Anthropic carries `signature`, OpenAI carries `id` +
// `encrypted_content`. pi-ai collapses both into one `thinkingSignature` string
// (for OpenAI, the whole reasoning item JSON; for Anthropic, the opaque
// signature). This module rebuilds pi-ai's shape on the way in and Zero's shape
// on the way out, so encrypted reasoning still round-trips across a resumed turn.

import {
  createModels,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type Context,
  type ImageContent,
  type Message as PiMessage,
  type Model,
  type MutableModels,
  type StopReason as PiStopReason,
  type TextContent,
  type ThinkingContent,
  type Tool as PiTool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  ContentBlock,
  StopReason,
  ThinkingBlock,
  TokenUsage,
  ToolResultContent,
} from "./protocol";
import type { Env } from "../types";
import { log } from "../log";
import { recordAgentUsage, type AiUsageAttribution } from "./ai-usage";
import type { AgentLabel, Effort } from "./model";

const PROVIDER_ID = "cloudflare-ai-gateway";

// Reasoning tokens are billed and counted as output, and at high effort they
// dominate a hard turn, so this ceiling is well above a non-reasoning one.
const MAX_OUTPUT_TOKENS = 32000;
// Per-attempt request timeout, well inside a DO alarm's patience. Retries are
// bounded so a 429 burst cannot stretch a turn indefinitely.
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

// Prompt-cache routing key. The static system instructions and tool schemas are
// byte-identical across users, so the key is shared for that prefix to be
// reused; it is namespaced per agent (each agent has a different prefix) and
// versioned so a prompt change cannot land on a stale route. `SHARDS` splits
// traffic across more keys under OpenAI's per-key rate guidance; keep the
// mapping stable so a user keeps hitting the same shard.
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

// One Models collection with the built-in gateway provider registered. The
// provider is stateless (pure fetch, no cross-call state) and its catalog is
// static, so a process-wide singleton is safe; per-call values (fetch, env,
// headers) all ride on the request options, never on the provider.
let modelsSingleton: MutableModels | undefined;
const models = (): MutableModels => {
  if (!modelsSingleton) {
    const m = createModels();
    m.setProvider(cloudflareAIGatewayProvider());
    modelsSingleton = m;
  }
  return modelsSingleton;
};

export interface PiAdapterOptions {
  env: Env;
  clerkUserId: string;
  agent: AgentLabel;
  modelId: string;
  effort: Effort;
  // The `cf-aig-metadata` header value, built once by the factory.
  metadata: string;
  // Test seam: the request bytes are what the prompt cache keys on, so tests
  // assert on them by intercepting the transport. Production passes nothing.
  fetchImpl?: typeof fetch;
  attribution?: AiUsageAttribution;
}

// --- error surfacing ---

// pi-ai's `completeSimple` resolves with an assistant message carrying
// `stopReason: "error"` instead of throwing; the runner and llm-error.ts expect
// a thrown error with a `.status` (429/529 => rate limit). Rebuild that.
const llmError = (
  message: string | undefined,
  status: number | undefined,
): Error => {
  const err = new Error(message ?? "LLM request failed") as Error & {
    status?: number;
  };
  if (status !== undefined) err.status = status;
  return err;
};

// --- request direction: Zero protocol -> pi-ai Context ---

const toResultContent = (
  content: ToolResultContent,
): (TextContent | ImageContent)[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type,
        },
  );
};

// A `thinking` block back into pi-ai's shape. OpenAI reasoning is the whole
// reasoning item JSON (what pi-ai `JSON.parse`s and replays verbatim); Anthropic
// reasoning is the opaque signature. A block with neither identity carries no
// replayable reasoning and is dropped (null), matching Zero's own rule.
const toThinkingContent = (block: ThinkingBlock): ThinkingContent | null => {
  if (block.id && block.encrypted_content) {
    return {
      type: "thinking",
      thinking: block.thinking || "",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: block.id,
        summary: [],
        encrypted_content: block.encrypted_content,
      }),
    };
  }
  if (block.signature) {
    return {
      type: "thinking",
      thinking: block.thinking,
      thinkingSignature: block.signature,
    };
  }
  return null;
};

const phaseSignature = (
  phase: "commentary" | "final_answer" | undefined,
): string | undefined =>
  phase ? JSON.stringify({ v: 1, id: "", phase }) : undefined;

const toAssistantContent = (
  blocks: ContentBlock[],
): (TextContent | ThinkingContent | ToolCall)[] => {
  const out: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      out.push({
        type: "text",
        text: block.text,
        ...(phaseSignature(block.phase)
          ? { textSignature: phaseSignature(block.phase) }
          : {}),
      });
    } else if (block.type === "thinking") {
      const thinking = toThinkingContent(block);
      if (thinking) out.push(thinking);
    } else if (block.type === "redacted_thinking") {
      out.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: block.data,
        redacted: true,
      });
    } else if (block.type === "tool_use") {
      out.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
    // Images and tool results never appear in an assistant message.
  }
  return out;
};

// Which wire produced a stored assistant message. pi-ai replays reasoning
// verbatim only when the message's `api` matches the target model's; otherwise
// it converts reasoning to text. Zero infers the source api from the thinking
// block's shape so a provider flip (rollback to claude) drops OpenAI reasoning
// instead of replaying it into the wrong wire.
const inferApi = (blocks: ContentBlock[], fallback: Api): Api => {
  for (const block of blocks) {
    if (block.type === "thinking") {
      if (block.id && block.encrypted_content) return "openai-responses";
      if (block.signature) return "anthropic-messages";
    }
  }
  return fallback;
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const toBlocks = (content: AgentMessage["content"]): ContentBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const toMessages = (
  message: AgentMessage,
  modelId: string,
  modelApi: Api,
): PiMessage[] => {
  const blocks = toBlocks(message.content);
  if (message.role === "assistant") {
    return [
      {
        role: "assistant",
        content: toAssistantContent(blocks),
        api: inferApi(blocks, modelApi),
        provider: PROVIDER_ID,
        model: modelId,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ];
  }
  // A user turn mixes text/images (one user message) with tool results (each a
  // separate top-level toolResult message). Splitting on tool_result preserves
  // order the way the wire requires.
  const out: PiMessage[] = [];
  let pending: (TextContent | ImageContent)[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push({ role: "user", content: pending, timestamp: Date.now() });
    pending = [];
  };
  for (const block of blocks) {
    if (block.type === "tool_result") {
      flush();
      out.push({
        role: "toolResult",
        toolCallId: block.tool_use_id,
        toolName: "",
        content: toResultContent(block.content),
        isError: block.is_error ?? false,
        timestamp: Date.now(),
      });
    } else if (block.type === "text") {
      pending.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      pending.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type,
      });
    }
  }
  flush();
  return out;
};

export const toContext = (
  request: AgentModelRequest,
  modelId: string,
  modelApi: Api,
): Context => {
  const systemPrompt = request.system.map((b) => b.text).join("\n\n");
  const tools: PiTool[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Zero defines tool schemas as JSON Schema (Zod -> z.toJSONSchema). pi-ai's
    // `Tool.parameters` is a TypeBox `TSchema`, which is structurally JSON
    // Schema at runtime, so the schema passes straight through.
    parameters: tool.input_schema,
  }));
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: request.messages.flatMap((m) => toMessages(m, modelId, modelApi)),
    ...(tools.length > 0 ? { tools } : {}),
  };
};

// --- response direction: pi-ai AssistantMessage -> Zero protocol ---

const phaseOf = (
  signature: string | undefined,
): "commentary" | "final_answer" | undefined => {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature) as { phase?: unknown };
    return parsed.phase === "commentary" || parsed.phase === "final_answer"
      ? parsed.phase
      : undefined;
  } catch {
    return undefined;
  }
};

const fromThinking = (content: ThinkingContent): ContentBlock => {
  if (content.redacted) {
    return { type: "redacted_thinking", data: content.thinkingSignature ?? "" };
  }
  if (content.thinkingSignature) {
    try {
      const item = JSON.parse(content.thinkingSignature) as {
        type?: unknown;
        id?: unknown;
        encrypted_content?: unknown;
      };
      if (
        item.type === "reasoning" &&
        typeof item.id === "string" &&
        typeof item.encrypted_content === "string"
      ) {
        return {
          type: "thinking",
          thinking: content.thinking || "",
          signature: "",
          id: item.id,
          encrypted_content: item.encrypted_content,
        };
      }
    } catch {
      // Not a JSON reasoning item: an opaque Anthropic signature.
    }
    return {
      type: "thinking",
      thinking: content.thinking,
      signature: content.thinkingSignature,
    };
  }
  return { type: "thinking", thinking: content.thinking, signature: "" };
};

export const fromAssistant = (
  content: PiAssistantMessage["content"],
): ContentBlock[] =>
  content.map((c): ContentBlock => {
    if (c.type === "text") {
      const phase = phaseOf(c.textSignature);
      return { type: "text", text: c.text, ...(phase ? { phase } : {}) };
    }
    if (c.type === "thinking") return fromThinking(c);
    // toolCall. pi-ai encodes the id as `callId|itemId`; Zero stores the call id.
    return {
      type: "tool_use",
      id: c.id.split("|")[0],
      name: c.name,
      input: c.arguments,
    };
  });

export const toStopReason = (reason: PiStopReason): StopReason | null => {
  switch (reason) {
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
};

export const toTokenUsage = (usage: Usage): TokenUsage => ({
  inputTokens: usage.input,
  outputTokens: usage.output,
  cacheReadTokens: usage.cacheRead,
  cacheWriteTokens: usage.cacheWrite,
  // OpenAI reports no 1h split, so its whole write lands in the 5m bucket;
  // Anthropic reports `cacheWrite1h`, and the rest is 5m.
  cacheWrite5mTokens: usage.cacheWrite - (usage.cacheWrite1h ?? 0),
  cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
  // Provider-reported dollar cost of this call; no hand-kept price table.
  costUsd: usage.cost.total,
});

export const createPiModel = (options: PiAdapterOptions): AgentModel => {
  const { env, clerkUserId, agent, modelId, effort, metadata, fetchImpl } =
    options;
  const base = models().getModel(PROVIDER_ID, modelId);
  if (!base) {
    throw new Error(`Unknown model in gateway catalog: ${modelId}`);
  }
  // A dev/test base-URL override replaces the templated gateway URL; auth still
  // supplies the gateway headers, so the mock server sees the same request.
  const model: Model<Api> = env.LLM_BASE_URL_OVERRIDE
    ? { ...base, baseUrl: env.LLM_BASE_URL_OVERRIDE }
    : base;

  let reportedModelId: string = modelId;
  return {
    modelId,
    generate: async (
      request: AgentModelRequest,
    ): Promise<AgentModelResponse> => {
      let lastStatus: number | undefined;
      const result = await models().completeSimple(model, toContext(request, modelId, model.api), {
        env: {
          CLOUDFLARE_API_KEY: env.CLOUDFLARE_API_KEY,
          CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_GATEWAY_ID: env.CLOUDFLARE_GATEWAY_ID,
        },
        reasoning: effort,
        sessionId: promptCacheKey(agent, clerkUserId),
        cacheRetention: "long",
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
        // Runs after auth/model/explicit headers merge, so the per-user gateway
        // attribution rides along without forking the provider.
        transformHeaders: (h) => ({ ...h, "cf-aig-metadata": metadata }),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onResponse: (response) => {
          lastStatus = response.status;
        },
      });

      reportedModelId = result.responseModel ?? modelId;
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw llmError(result.errorMessage, lastStatus);
      }

      const usage = toTokenUsage(result.usage);
      // Content-free: token counts only. On a working cache, `cache_read_tokens`
      // grows step over step within a run while `input_tokens` stays small.
      log("cache_stats", {
        agent,
        ...(request.step !== undefined ? { step: request.step } : {}),
        input_tokens: usage.inputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        thinking_tokens: result.usage.reasoning ?? 0,
      });

      return {
        id: result.responseId ?? "",
        content: fromAssistant(result.content),
        stopReason: toStopReason(result.stopReason),
        usage,
      };
    },
    reportRunUsage: (usage) =>
      recordAgentUsage(env, {
        clerkUserId,
        model: reportedModelId,
        agent,
        attribution: options.attribution,
        usage,
        cost: {
          estimatedCostUsd: usage.costUsd,
          // The catalog carries real per-token rates for a priced model; a model
          // with no rate records tokens without a fake zero-dollar cost.
          pricingStatus:
            base.cost.input > 0 || base.cost.output > 0 ? "priced" : "unpriced",
          // Catalog sentinel: models.dev prices move with no stable version.
          pricingVersion: base.id,
        },
      }),
  };
};
