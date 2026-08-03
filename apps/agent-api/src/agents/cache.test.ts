import { describe, expect, it } from "vitest";
import {
  cacheControl,
  cachedSystem,
  markCacheBreakpoint,
  markMessageBreakpoints,
} from "./cache";
import type { AgentMessage } from "./protocol";

describe("cacheControl", () => {
  // No TTL: OpenAI sets it request-wide and Anthropic's adapter sets its own.
  it("is a bare ephemeral marker", () => {
    expect(cacheControl()).toEqual({ type: "ephemeral" });
  });
});

describe("cachedSystem", () => {
  it("builds one marked block when there is no per-user tail", () => {
    expect(cachedSystem("instructions", "")).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  // The head is byte-identical across users, so it must stay a block of its own:
  // folding the per-user tail into it would make every user's prefix unique.
  it("gives the per-user tail its own breakpoint after the head", () => {
    expect(cachedSystem("instructions", "\n\npinned")).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "\n\npinned",
        cache_control: { type: "ephemeral" },
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

describe("markMessageBreakpoints", () => {
  // The last markable content block of a message carries the breakpoint, so a
  // message is "marked" iff one of its blocks has cache_control.
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

  it("marks every markable message and no assistant message", () => {
    expect(markedIndexes(markMessageBreakpoints(convo(6)))).toEqual([0, 2, 4]);
  });

  // The invariant the whole policy rests on: a marker is part of the cached
  // bytes, so the same messages must always produce the same marks. If this
  // drifts, every prefix misses and every step is re-billed as a cache write.
  it("is deterministic: marking twice yields identical bytes", () => {
    const messages = convo(7);
    expect(JSON.stringify(markMessageBreakpoints(messages))).toBe(
      JSON.stringify(markMessageBreakpoints(messages)),
    );
  });

  // Step N+1 must carry every mark step N carried, or step N's write is lost.
  it("keeps earlier marks in place as the conversation grows", () => {
    let messages = convo(1);
    const marks: number[][] = [];
    for (let step = 0; step < 4; step++) {
      marks.push(markedIndexes(markMessageBreakpoints(messages)));
      messages = [
        ...messages,
        { role: "assistant", content: `a${step}` },
        { role: "user", content: `t${step}` },
      ];
    }
    expect(marks).toEqual([[0], [0, 2], [0, 2, 4], [0, 2, 4, 6]]);
  });

  it("marks the last markable block of a multi-block message", () => {
    const marked = markMessageBreakpoints([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
    ]);
    const blocks = marked[0].content as Array<{ cache_control?: unknown }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns an empty list unchanged and does not mutate the input", () => {
    expect(markMessageBreakpoints([])).toEqual([]);
    const input = convo(3);
    const snapshot = JSON.stringify(input);
    markMessageBreakpoints(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("leaves a list of assistant messages untouched", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: "only" },
      { role: "assistant", content: "another" },
    ];
    expect(markMessageBreakpoints(messages)).toEqual(messages);
  });
});
