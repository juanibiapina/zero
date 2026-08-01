import { describe, expect, it } from "vitest";
import {
  cacheControl,
  cachedSystem,
  markCacheBreakpoint,
  markLastTool,
  slideMessageBreakpoint,
} from "./cache";
import type { AgentMessage, AgentToolDefinition } from "./protocol";

const definition = (name: string): AgentToolDefinition => ({
  name,
  description: name,
  input_schema: { type: "object" },
});

describe("cacheControl", () => {
  it("omits ttl by default and includes it when given", () => {
    expect(cacheControl()).toEqual({ type: "ephemeral" });
    expect(cacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("cachedSystem", () => {
  it("builds a system text block with a cache breakpoint", () => {
    expect(cachedSystem("instructions", "1h")).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});

describe("markLastTool", () => {
  const tools = [definition("a"), definition("b")];

  it("marks only the last tool and preserves order", () => {
    const marked = markLastTool(tools, "1h");
    expect(marked.map((t) => t.name)).toEqual(["a", "b"]);
    expect(marked[0].cache_control).toBeUndefined();
    expect(marked[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Original untouched.
    expect(tools[1].cache_control).toBeUndefined();
  });

  it("no-ops on an empty tool list", () => {
    expect(markLastTool([])).toEqual([]);
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

  // Anthropic rejects cache_control on a thinking block, and a response cut off
  // during thinking ends on one. Leaving the message unmarked costs one
  // breakpoint; marking it costs the whole request.
  it("leaves a message ending in a thinking block unmarked", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "one moment" },
        { type: "thinking", thinking: "", signature: "sig-1" },
      ],
    };
    expect(markCacheBreakpoint(message)).toEqual(message);
  });

  it("leaves a message ending in a redacted thinking block unmarked", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "one moment" },
        { type: "redacted_thinking", data: "encrypted" },
      ],
    };
    expect(markCacheBreakpoint(message)).toEqual(message);
  });

  it("leaves an all-thinking message unmarked", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "sig-1" }],
    };
    expect(markCacheBreakpoint(message)).toEqual(message);
  });

  it("still marks a message whose thinking is followed by text", () => {
    const marked = markCacheBreakpoint({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "the answer" },
      ],
    });
    const blocks = marked.content as Array<{ cache_control?: unknown }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("slideMessageBreakpoint", () => {
  // The last content block of a message carries the breakpoint, so a message is
  // "marked" iff its last block has cache_control.
  const isMarked = (m: AgentMessage): boolean => {
    if (typeof m.content === "string") return false;
    const last = m.content[m.content.length - 1];
    return !!(last && "cache_control" in last && last.cache_control);
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

  it("lands on index N-1 for a list of N messages", () => {
    for (const n of [1, 2, 5, 21]) {
      expect(markedIndexes(slideMessageBreakpoint(convo(n)))).toEqual([n - 1]);
    }
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
    // Interface shape: an anchor on the second-to-last message. tools + system
    // spend 2 breakpoints, so the messages region may spend at most 2 more.
    const withAnchor: AgentMessage[] = [
      { role: "user", content: "old" },
      markCacheBreakpoint({ role: "assistant", content: "stable" }),
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
