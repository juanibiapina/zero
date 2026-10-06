// Zero's tool shape and the content blocks of the legacy UserDO transcript.
// Tools are defined here with zod; assistant/tools.ts turns them into Pi Durable
// tool registrations. The block types mirror the Anthropic Messages wire format
// the legacy `messages` table stored, which assistant/legacy-import.ts reads.

import { z } from "zod";

export interface TextBlock {
  type: "text";
  text: string;
  // Assistant text only: whether the model labelled this as intermediate
  // commentary or its final answer. Recent models degrade when a replayed
  // assistant message loses its phase, so it is stored and sent back verbatim.
  phase?: "commentary" | "final_answer";
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

// What a tool hands back to the model. A string is the common case; the block
// array carries images (view_image) so the model sees pixels, not base64.
export type ToolResultContent = string | Array<TextBlock | ImageBlock>;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

// The model's reasoning, returned ahead of the text blocks when thinking is on.
// `thinking` is empty when the provider omits the readable reasoning (what Zero
// requests); the opaque part must be round-tripped unmodified or the API rejects
// the request.
//
// The two providers identify reasoning differently, and the fields are named
// after each: `signature` is Anthropic's, while `id` + `encrypted_content` are
// the OpenAI reasoning item's. A block carrying the wrong provider's fields is
// dropped on the way to the model rather than translated — reasoning is never
// required for correctness, only for quality, so a conversation written under
// one provider stays usable under the other.
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
  id?: string;
  encrypted_content?: string;
}

// Reasoning the safety system flagged and encrypted wholesale. Opaque, and
// round-tripped exactly like a thinking block.
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

// The blocks Zero produces or reads. Model responses may still contain types
// Zero does not model (server tool use); those are round-tripped verbatim into
// the next request rather than reserialized, so they need no type here.
// Thinking is modelled because Zero has to *recognize* it: it must never be
// rendered as prose.
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

// Token counts for one model call. `inputTokens` is the uncached, full-price
// input; cache read/write are billed separately. See docs/caching.md.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  // Dollar cost of this one call, as reported by the provider layer (pi-ai's
  // `usage.cost.total`). Optional because a mock or a model with no catalog
  // price leaves it unset; readers treat missing as zero.
  costUsd?: number;
}

export interface AgentRunUsage extends TokenUsage {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  // Summed `costUsd` across every call in the run.
  costUsd: number;
  modelCalls: number;
}

// A tool the runner can dispatch. `execute` receives input already validated
// against `inputSchema`; a thrown error becomes an error tool_result rather
// than failing the run (the interface agent's send path depends on this).
export interface AgentTool<Input = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<unknown>;
  // Optional custom serialization of the tool's output into result blocks.
  // Defaults to a string passthrough / deterministic JSON.
  toContent?: (output: unknown) => {
    content: ToolResultContent;
    isError?: boolean;
  };
  // True for a call that changes the world outside Zero and cannot be replayed
  // (sending mail, creating a calendar event). The runner claims such a call
  // durably before it leaves and refuses to repeat one whose outcome is unknown.
  externalWrite?: boolean;
}

export type AgentToolSet = Record<string, AgentTool>;

// Define a tool with input inferred from its Zod schema. The cast is the whole
// point of the helper: it keeps `execute` typed at the definition site while the
// tool set stays homogeneous (`AgentTool<unknown>`) for the runner.
export const defineTool = <Schema extends z.ZodType>(def: {
  description: string;
  inputSchema: Schema;
  execute: (input: z.output<Schema>) => Promise<unknown>;
  toContent?: AgentTool["toContent"];
  externalWrite?: boolean;
}): AgentTool => def as unknown as AgentTool;
