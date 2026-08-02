// Prompt-caching helpers. The provider caches a request's stable prefix in the
// order tools -> system -> messages; we place up to 4 breakpoints over that
// prefix so a later request sharing the byte-identical prefix reads it from
// cache instead of re-billing it. This module hides the placement behind named
// intent so run.ts and interface.ts express *what* to cache, not where the
// field goes. See docs/caching.md.
//
// Four is the per-request write budget, and Zero spends all four: the static
// system head, the per-user system tail (pinned topics), a caller anchor (the
// interface agent's last stable history message), and the loop's sliding
// breakpoint on the growing tail. The tool loop advances the sliding breakpoint
// to the new tail each step instead of accumulating more.
//
// Tools carry no breakpoint: the Responses API accepts one only on an input
// content block, and tools are rendered into the prefix ahead of the input, so
// the system head's breakpoint already covers every tool schema.

import { isCacheable } from "./protocol";
import type {
  AgentMessage,
  CacheControl,
  CacheTtl,
  ContentBlock,
  TextBlock,
} from "./protocol";

export type { CacheTtl };

// The breakpoint marker itself. `ttl` defaults to 5m at the API; pass "1h" for
// the shared, high-reuse prefixes (tools, static system) where the higher write
// premium is amortized over huge read volume.
export const cacheControl = (ttl?: CacheTtl): CacheControl => ({
  type: "ephemeral" as const,
  ...(ttl ? { ttl } : {}),
});

// The `system` region as text blocks, each carrying a breakpoint.
//
// `head` is the static instructions: byte-identical for every user, so its
// breakpoint is the prefix that stays warm across the whole user base (and it
// covers the tool schemas rendered before it). `tail` is per-user (the pinned
// topics); it gets its own breakpoint so a change to one user's pinned topics
// cannot invalidate the shared head. An empty tail adds no block, which keeps
// the request bytes identical to a user with nothing pinned.
export const cachedSystem = (
  head: string,
  tail = "",
  ttl?: CacheTtl,
): TextBlock[] => [
  { type: "text", text: head, cache_control: cacheControl(ttl) },
  ...(tail === ""
    ? []
    : [
        {
          type: "text" as const,
          text: tail,
          cache_control: cacheControl(ttl),
        },
      ]),
];

// Add a breakpoint to a message. The marker goes on the last block that can
// carry one (a string content is promoted to a single text block). Used for the
// messages-region sliding window (last stable message + current message).
//
// Only an *input* block can carry a breakpoint: the API accepts one on
// `input_text` / `input_image` / `input_file`, never on assistant output, a tool
// call, or a reasoning block. So this walks back from the tail to the last
// markable block and marks that one, and a message with none (a pure assistant
// reply, a response truncated mid-reasoning) is returned unmarked. Walking back
// rather than giving up at the tail matters because an assistant message's own
// blocks are all unmarkable, and the caller's anchor lands on exactly such a
// message.
export const markCacheBreakpoint = (
  message: AgentMessage,
  ttl?: CacheTtl,
): AgentMessage => {
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
      i === index ? { ...block, cache_control: cacheControl(ttl) } : block,
    ),
  };
};

// The loop-owned sliding message-region breakpoint. Called on a per-request
// snapshot of the messages array before every step: it marks the tail of the
// growing conversation, so step N reads everything through step N-1 and writes
// only step N-1's delta — the write-then-read pattern that caches a growing
// conversation (see docs/caching.md).
//
// It marks the last message that *can* carry a breakpoint, which is the last
// message outright in the normal loop (the current user message, or the tool
// results just appended). When the tail is an assistant message — a run resumed
// straight after a response was persisted — it walks back instead of losing the
// step's breakpoint entirely.
//
// Pure: returns a new array and marks a clone, so the runner's persisted
// `messages` and the model's round-tripped blocks stay clean. Exactly one
// sliding breakpoint is added; any caller anchor breakpoint earlier in the array
// is preserved untouched, keeping the per-request budget at four (system head +
// system tail + anchor + sliding). An empty array is returned unchanged.
export const slideMessageBreakpoint = (
  messages: AgentMessage[],
  ttl?: CacheTtl,
): AgentMessage[] => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const marked = markCacheBreakpoint(messages[index], ttl);
    if (marked === messages[index]) continue;
    return messages.map((message, i) => (i === index ? marked : message));
  }
  return messages;
};
