import { describe, expect, it } from "vitest";
import {
  cacheControl,
  cachedSystem,
  markCacheBreakpoint,
  slideMessageBreakpoint,
} from "./cache";
import type { AgentMessage } from "./protocol";

describe("cacheControl", () => {
  it("omits ttl by default and includes it when given", () => {
    expect(cacheControl()).toEqual({ type: "ephemeral" });
    expect(cacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("cachedSystem", () => {
  it("builds one marked block when there is no per-user tail", () => {
    expect(cachedSystem("instructions", "", "1h")).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  // The head is byte-identical across users, so it must stay a block of its own:
  // folding the per-user tail into it would make every user's prefix unique.
  it("gives the per-user tail its own breakpoint after the head", () => {
    expect(cachedSystem("instructions", "\n\npinned", "1h")).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: "\n\npinned",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});

describe("markCacheBreakpoint", () => {
  it("promotes string content to a text block carrying the breakpoint", () => {
    expect(markCacheBreakpoint({ role: "user", content: "hello" })).toEqual({
      role: "user",
      content: [
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("marks only the last block of a multi-block message", () => {
    const marked = markCacheBreakpoint({
      role: "user",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    });
    const blocks = marked.content as Array<{ cache_control?: unknown }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  // Only an input block can carry a breakpoint, and an assistant message has
  // none: its text is output, its tool calls and reasoning are not markable.
  it("leaves an assistant message unmarked whatever it contains", () => {
    for (const content of [
      "plain reply",
      [{ type: "text" as const, text: "the answer" }],
      [
        { type: "text" as const, text: "one moment" },
        { type: "thinking" as const, thinking: "", signature: "sig-1" },
      ],
      [{ type: "thinking" as const, thinking: "", signature: "sig-1" }],
    ]) {
      const message: AgentMessage = { role: "assistant", content };
      expect(markCacheBreakpoint(message)).toEqual(message);
    }
  });

  // A tool-result turn is a user message, and its blocks are input blocks.
  it("marks the last block of a tool-result turn", () => {
    const marked = markCacheBreakpoint({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "one" },
        { type: "tool_result", tool_use_id: "b", content: "two" },
      ],
    });
    const blocks = marked.content as Array<{ cache_control?: unknown }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns an empty message unchanged", () => {
    const message: AgentMessage = { role: "user", content: [] };
    expect(markCacheBreakpoint(message)).toEqual(message);
  });
});

describe("slideMessageBreakpoint", () => {
  // The last content block of a message carries the breakpoint, so a message is
  // "marked" iff its last block has cache_control.
  const isMarked = (m: AgentMessage): boolean => {
    if (typeof m.content === "string") return false;
    return m.content.some((b) => "cache_control" in b && b.cache_control);
  };
  const markedIndexes = (ms: AgentMessage[]): number[] =>
    ms.flatMap((m, i) => (isMarked(m) ? [i] : []));

  const convo = (n: number): AgentMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));

  it("marks the last message and no other", () => {
    const marked = slideMessageBreakpoint(convo(3));
    expect(markedIndexes(marked)).toEqual([2]);
  });

  it("lands on the tail whenever the tail is a user message", () => {
    for (const n of [1, 3, 5, 21]) {
      expect(markedIndexes(slideMessageBreakpoint(convo(n)))).toEqual([n - 1]);
    }
  });

  // A run resumed right after an assistant response was persisted has an
  // assistant tail, which cannot carry a breakpoint. Walking back keeps the
  // step's write instead of skipping it.
  it("walks back past an unmarkable assistant tail", () => {
    expect(markedIndexes(slideMessageBreakpoint(convo(2)))).toEqual([0]);
  });

  it("returns the list unchanged when nothing can be marked", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "only" }];
    expect(slideMessageBreakpoint(messages)).toBe(messages);
  });

  it("advances the breakpoint to the new tail as the list grows", () => {
    // Simulate the tool loop appending an assistant + tool_result each step.
    let messages = convo(1);
    const marks: number[] = [];
    for (let step = 0; step < 4; step++) {
      marks.push(markedIndexes(slideMessageBreakpoint(messages))[0]);
      messages = [
        ...messages,
        { role: "assistant", content: `a${step}` },
        { role: "user", content: `t${step}` },
      ];
    }
    // Each step's breakpoint sits on the current tail and strictly advances.
    expect(marks).toEqual([0, 2, 4, 6]);
  });

  it("preserves a caller anchor and never exceeds the 4-breakpoint budget", () => {
    // Interface shape: an anchor on the last markable message before the current
    // one. The system head + tail spend 2 breakpoints, so the messages region
    // may spend at most 2 more.
    const withAnchor: AgentMessage[] = [
      { role: "assistant", content: "old reply" },
      markCacheBreakpoint({ role: "user", content: "stable" }),
      { role: "user", content: "current" },
    ];
    const marked = slideMessageBreakpoint(withAnchor);
    // Anchor (index 1) preserved, sliding added on the tail (index 2).
    expect(markedIndexes(marked)).toEqual([1, 2]);
    const messageBreakpoints = marked
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => "cache_control" in b && b.cache_control).length;
    expect(2 + messageBreakpoints).toBeLessThanOrEqual(4);
  });

  it("returns an empty list unchanged and does not mutate the input", () => {
    expect(slideMessageBreakpoint([])).toEqual([]);
    const input = convo(2);
    const snapshot = JSON.stringify(input);
    slideMessageBreakpoint(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("passes a ttl through to the marked block", () => {
    const marked = slideMessageBreakpoint(convo(1), "1h");
    const block = (marked[0].content as Array<{ cache_control?: unknown }>)[0];
    expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
