// Prompt-caching helpers. The provider caches a request's stable prefix in the
// order tools -> system -> messages; a breakpoint marks the end of a prefix, and
// a later request whose bytes match up to that same marker reads it instead of
// re-billing it. This module hides the placement behind named intent so run.ts
// expresses *what* to cache, not where the field goes. See docs/caching.md.
//
// Two rules, both measured against the live API (docs/caching.md, Probe):
//
// 1. A marker is part of the cached bytes. Removing a marker that an earlier
//    request carried changes the prefix and invalidates everything after it. So
//    marks only ever accumulate: `markMessageBreakpoints` marks EVERY message
//    that can carry one, which makes the layout a pure function of the message
//    array and therefore byte-identical from step to step and turn to turn.
// 2. Marker count is not a budget. A request may carry any number; the service
//    writes at most the latest four and treats the rest as read-only, which is
//    exactly what makes a growing conversation cost only its per-step delta.
//    (Anthropic caps markers at 4 and errors above it. That is the Anthropic
//    adapter's problem, and it trims there.)
//
// Tools carry no breakpoint: a marker goes only on an input content block, and
// tools are rendered into the prefix ahead of the input, so the system head's
// breakpoint already covers every tool schema.

import { isCacheable } from "./protocol";
import type {
  AgentMessage,
  CacheControl,
  ContentBlock,
  TextBlock,
} from "./protocol";

// The breakpoint marker itself. TTL is deliberately absent: OpenAI sets it
// request-wide (30m, the only supported value) and the Anthropic adapter picks
// its own per region, so no caller here has a TTL opinion to express.
export const cacheControl = (): CacheControl => ({ type: "ephemeral" });

// The `system` region as text blocks, each carrying a breakpoint.
//
// `head` is the static instructions: byte-identical for every user, so its
// breakpoint is the prefix that stays warm across the whole user base (and it
// covers the tool schemas rendered before it). `tail` is per-user (the pinned
// topics); it gets its own breakpoint so a change to one user's pinned topics
// cannot invalidate the shared head. An empty tail adds no block, which keeps
// the request bytes identical to a user with nothing pinned.
export const cachedSystem = (head: string, tail = ""): TextBlock[] => [
  { type: "text", text: head, cache_control: cacheControl() },
  ...(tail === ""
    ? []
    : [{ type: "text" as const, text: tail, cache_control: cacheControl() }]),
];

// Add a breakpoint to a message. The marker goes on the last block that can
// carry one (a string content is promoted to a single text block).
//
// Only an *input* block can carry a breakpoint: the API accepts one on
// `input_text` / `input_image` / `input_file`, never on assistant output, a tool
// call, or a reasoning block. So this walks back from the tail to the last
// markable block and marks that one, and a message with none (a pure assistant
// reply, a response truncated mid-reasoning) is returned unmarked. Walking back
// rather than giving up at the tail matters because a message can end on an
// unmarkable block while still carrying markable content.
export const markCacheBreakpoint = (message: AgentMessage): AgentMessage => {
  const blocks: ContentBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (message.role === "assistant") return message;
  const index = blocks.findLastIndex(isCacheable);
  if (index === -1) return message;
  return {
    ...message,
    content: blocks.map((block, i) =>
      i === index ? { ...block, cache_control: cacheControl() } : block,
    ),
  };
};

// Mark every message that can carry a breakpoint, on a per-request snapshot.
//
// This is the whole message-region policy, and it is a pure function of the
// array: the same messages always produce the same marks, so step N+1's prefix
// matches step N's byte for byte up to step N's tail and reads it back, while
// only the newly appended messages are written. The same determinism is what
// makes the *next turn* read this turn's history: the persisted log is unchanged
// and re-marking it reproduces the identical bytes.
//
// Any earlier caller-set marker is therefore redundant rather than harmful; a
// caller has no marking decision left to make.
//
// Pure: returns a new array and marks clones, so the runner's persisted
// `messages` and the model's round-tripped blocks stay clean. An empty array is
// returned unchanged.
export const markMessageBreakpoints = (
  messages: AgentMessage[],
): AgentMessage[] => messages.map(markCacheBreakpoint);
