// Protocol <-> OpenAI Responses wire translation. Pure: no SDK, no I/O, no
// clock. The adapter (model-openai.ts) owns the network; this module owns every
// decision about what the bytes look like, because the prompt cache keys on
// exactly those bytes and a byte-unstable translation is a silent cost bug.
//
// Zero's protocol mirrors the Anthropic Messages format (see protocol.ts), so
// this module is where that shape meets a different API:
//
// - `system` text blocks    -> one leading `developer` message
// - user text/images        -> `input_text` / `input_image` blocks
// - `tool_result`           -> a top-level `function_call_output` item
// - assistant text          -> `assistant` message items (carrying `phase`)
// - `tool_use`              -> `function_call` items
// - `thinking`              -> `reasoning` items (id + encrypted_content)
// - `cache_control`         -> `prompt_cache_breakpoint: { mode: "explicit" }`

import type {
  AgentMessage,
  AgentToolDefinition,
  ContentBlock,
  StopReason,
  TextBlock,
  TokenUsage,
} from "./protocol";

// --- wire shapes (only what Zero sends or reads) ---

export interface WireBreakpoint {
  mode: "explicit";
}

export interface WireInputText {
  type: "input_text";
  text: string;
  prompt_cache_breakpoint?: WireBreakpoint;
}

export interface WireInputImage {
  type: "input_image";
  image_url: string;
  prompt_cache_breakpoint?: WireBreakpoint;
}

export type WireInputContent = WireInputText | WireInputImage;

export type WireItem =
  | { role: "developer" | "user"; content: WireInputContent[] }
  | { role: "assistant"; content: string; phase?: "commentary" | "final_answer" }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: WireInputContent[] }
  | { type: "reasoning"; id: string; summary: []; encrypted_content: string };

export interface WireTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}

export type WireOutputItem =
  | {
      type: "message";
      role?: string;
      phase?: "commentary" | "final_answer";
      content?: Array<
        | { type: "output_text"; text: string }
        | { type: "refusal"; refusal: string }
      >;
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null }
  | { type: string };

// The subset of the response Zero reads. Anything else on the wire is ignored.
export interface WireResponse {
  id: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: WireOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

const BREAKPOINT: WireBreakpoint = { mode: "explicit" };

// --- request direction ---

// Tool schemas, key order fixed at construction. Order is part of the cached
// prefix, so it must not depend on object iteration luck.
export const toWireTools = (tools: AgentToolDefinition[]): WireTool[] =>
  tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    // Zod-generated schemas are not all strict-mode compatible (an optional
    // field means not every key is required), and a strict violation is a hard
    // 400 rather than a degraded call.
    strict: false,
  }));

const inputText = (text: string, marked: boolean): WireInputText => ({
  type: "input_text",
  text,
  ...(marked ? { prompt_cache_breakpoint: BREAKPOINT } : {}),
});

const toWireImage = (
  block: Extract<ContentBlock, { type: "image" }>,
  marked: boolean,
): WireInputImage => ({
  type: "input_image",
  image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  ...(marked ? { prompt_cache_breakpoint: BREAKPOINT } : {}),
});

// A tool result's content as input blocks. Always the list form, never the bare
// string shorthand: the marked and unmarked forms of the same result must differ
// by the marker alone, since switching representation would change far more of
// the cached prefix than the marker itself.
const toolResultContent = (
  block: Extract<ContentBlock, { type: "tool_result" }>,
): WireInputContent[] => {
  const marked = block.cache_control !== undefined;
  if (typeof block.content === "string") {
    return [inputText(block.content, marked)];
  }
  if (block.content.length === 0) return [inputText("", marked)];
  // Only the last part carries the marker: a breakpoint marks the end of a
  // prefix, so marking an earlier part would cache less than intended.
  return block.content.map((part, index) => {
    const last = index === block.content.length - 1;
    return part.type === "text"
      ? inputText(part.text, marked && last)
      : toWireImage(part, marked && last);
  });
};

// Can a preceding reasoning item legitimately belong to this block?
const followsReasoning = (block: ContentBlock): boolean =>
  block.type === "text" || block.type === "tool_use";

// One assistant message's blocks as wire items, in order.
//
// A `reasoning` item is only valid when the item it produced is still present.
// Zero's context window can open anywhere (a paged read, a compaction boundary),
// so a reasoning block with nothing after it inside its own message is dropped:
// an orphan is a hard 400, not a degraded answer. Reasoning from the previous
// provider (an Anthropic `thinking` block, which carries no id and no encrypted
// content) is dropped for the same reason — it cannot be replayed here.
const assistantItems = (blocks: ContentBlock[]): WireItem[] => {
  const items: WireItem[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const id = block.type === "thinking" ? block.id : undefined;
      const encrypted =
        block.type === "thinking" ? block.encrypted_content : undefined;
      if (!id || !encrypted) continue;
      if (!blocks.slice(index + 1).some(followsReasoning)) continue;
      items.push({
        type: "reasoning",
        id,
        summary: [],
        encrypted_content: encrypted,
      });
      continue;
    }
    if (block.type === "text") {
      items.push({
        role: "assistant",
        content: block.text,
        ...(block.phase ? { phase: block.phase } : {}),
      });
      continue;
    }
    if (block.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
    // Images and tool results never appear in an assistant message.
  }
  return items;
};

// One user message's blocks as wire items, in order. Tool results are top-level
// items rather than message content, so a message mixing them with text splits
// into several items instead of one.
const userItems = (blocks: ContentBlock[]): WireItem[] => {
  const items: WireItem[] = [];
  let pending: WireInputContent[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    items.push({ role: "user", content: pending });
    pending = [];
  };
  for (const block of blocks) {
    if (block.type === "tool_result") {
      flush();
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: toolResultContent(block),
      });
      continue;
    }
    if (block.type === "text") {
      pending.push(inputText(block.text, block.cache_control !== undefined));
      continue;
    }
    if (block.type === "image") {
      pending.push(toWireImage(block, block.cache_control !== undefined));
    }
    // A user message never carries tool_use or reasoning.
  }
  flush();
  return items;
};

const toBlocks = (content: AgentMessage["content"]): ContentBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

// The full `input` array: the system prompt as a leading `developer` message,
// then the conversation. The system prompt cannot ride in the `instructions`
// field because that field is a plain string, and only a content block can
// carry a cache breakpoint.
export const toWireInput = (
  system: TextBlock[],
  messages: AgentMessage[],
): WireItem[] => {
  const items: WireItem[] = [];
  if (system.length > 0) {
    items.push({
      role: "developer",
      content: system.map((block) =>
        inputText(block.text, block.cache_control !== undefined),
      ),
    });
  }
  for (const message of messages) {
    const blocks = toBlocks(message.content);
    items.push(
      ...(message.role === "assistant"
        ? assistantItems(blocks)
        : userItems(blocks)),
    );
  }
  return items;
};

// --- response direction ---

// Malformed arguments are the model's mistake, not a transport failure. An empty
// object flows into the tool's schema validation, which reports it back to the
// model as an error result — the same path a wrong argument already takes.
const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
};

type WireMessageItem = Extract<WireOutputItem, { type: "message" }>;

const messageParts = (item: WireOutputItem) =>
  (item as WireMessageItem).content ?? [];

export const fromWireOutput = (output: WireOutputItem[]): ContentBlock[] => {
  const blocks: ContentBlock[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      const reasoning = item as Extract<WireOutputItem, { type: "reasoning" }>;
      if (!reasoning.encrypted_content) continue;
      blocks.push({
        type: "thinking",
        // Nothing readable comes back: Zero never asks for a reasoning summary,
        // so the transcript stores identity and ciphertext only.
        thinking: "",
        signature: "",
        id: reasoning.id,
        encrypted_content: reasoning.encrypted_content,
      });
      continue;
    }
    if (item.type === "message") {
      const message = item as WireMessageItem;
      for (const part of messageParts(item)) {
        if (part.type === "output_text") {
          blocks.push({
            type: "text",
            text: part.text,
            ...(message.phase ? { phase: message.phase } : {}),
          });
        } else if (part.type === "refusal") {
          // A refusal is prose the user must see; storing it as a text block
          // keeps the delivery path (which only knows text) working.
          blocks.push({ type: "text", text: part.refusal });
        }
      }
      continue;
    }
    if (item.type === "function_call") {
      const call = item as Extract<WireOutputItem, { type: "function_call" }>;
      blocks.push({
        type: "tool_use",
        id: call.call_id,
        name: call.name,
        input: parseArguments(call.arguments),
      });
    }
    // Any other item type (the hosted server-side tools, which Zero does not
    // enable) is dropped rather than round-tripped: it cannot be replayed
    // without its server-side state.
  }
  return blocks;
};

// Responses reports completion as a status plus item types; Zero's protocol
// speaks Anthropic stop reasons, and `store/messages.ts` decides "does this
// conversation still owe work" from them. Deriving here keeps one vocabulary
// instead of teaching every reader a second one.
export const toStopReason = (response: WireResponse): StopReason | null => {
  const output = response.output ?? [];
  if (output.some((item) => item.type === "function_call")) return "tool_use";
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  )
    return "max_tokens";
  if (
    output.some(
      (item) =>
        item.type === "message" &&
        messageParts(item).some((part) => part.type === "refusal"),
    )
  )
    return "refusal";
  if (response.status === "completed") return "end_turn";
  return null;
};

// OpenAI bills one cache tier (30m minimum), so the 1h bucket stays zero and the
// 5m bucket carries every write. Keeping the existing field names means the
// Analytics Engine schema, the admin usage report, and the pricing table need no
// migration.
export const toUsage = (response: WireResponse): TokenUsage => {
  const usage = response.usage ?? {};
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    // Responses counts cached tokens inside `input_tokens`; Zero's protocol
    // means "uncached, full-price input" by it, so the cached part comes off.
    inputTokens: Math.max((usage.input_tokens ?? 0) - cacheRead, 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: cacheWrite,
    cacheWrite1hTokens: 0,
  };
};

export const reasoningTokens = (response: WireResponse): number =>
  response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
