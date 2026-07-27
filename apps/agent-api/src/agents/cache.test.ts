import { describe, expect, it } from "vitest";
import {
  cacheControl,
  cachedSystem,
  markCacheBreakpoint,
  markLastTool,
} from "./cache";
import type { AgentToolDefinition } from "./protocol";

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
});
