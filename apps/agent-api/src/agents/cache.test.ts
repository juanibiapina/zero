import { describe, expect, it } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  cacheControl,
  cachedSystemMessage,
  markCacheBreakpoint,
  markLastTool,
} from "./cache";

const cc = (opts: unknown) =>
  (opts as { anthropic?: { cacheControl?: unknown } })?.anthropic?.cacheControl;

describe("cacheControl", () => {
  it("omits ttl by default and includes it when given", () => {
    expect(cc(cacheControl())).toEqual({ type: "ephemeral" });
    expect(cc(cacheControl("1h"))).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("cachedSystemMessage", () => {
  it("builds a system-role message with a cache breakpoint", () => {
    const msg = cachedSystemMessage("instructions", "1h");
    expect(msg.role).toBe("system");
    expect(msg.content).toBe("instructions");
    expect(cc(msg.providerOptions)).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("markLastTool", () => {
  const tools: ToolSet = {
    a: tool({ description: "a", inputSchema: z.object({}) }),
    b: tool({ description: "b", inputSchema: z.object({}) }),
  };

  it("marks only the last tool and preserves order", () => {
    const marked = markLastTool(tools, "1h");
    expect(Object.keys(marked)).toEqual(["a", "b"]);
    expect(cc(marked.a.providerOptions)).toBeUndefined();
    expect(cc(marked.b.providerOptions)).toEqual({ type: "ephemeral", ttl: "1h" });
    // Original untouched.
    expect(tools.b.providerOptions).toBeUndefined();
  });

  it("no-ops on an empty tool set", () => {
    expect(markLastTool({})).toEqual({});
  });
});

describe("markCacheBreakpoint", () => {
  it("adds a breakpoint while preserving content", () => {
    const marked = markCacheBreakpoint({ role: "user", content: "hello" });
    expect(marked.content).toBe("hello");
    expect(cc(marked.providerOptions)).toEqual({ type: "ephemeral" });
  });
});
