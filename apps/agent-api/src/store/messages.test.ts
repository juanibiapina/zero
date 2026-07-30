import { describe, expect, it } from "vitest";
import {
  conversationHasWork,
  decodeContent,
  defaultKind,
  encodeContent,
  isTerminalStopReason,
  messageText,
} from "./messages";

describe("content encoding", () => {
  it("round-trips a string as one text block", () => {
    expect(decodeContent(encodeContent("hi"))).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("round-trips blocks verbatim, including unknown block types", () => {
    const blocks = [
      { type: "thinking", signature: "sig", thinking: "hmm" },
      { type: "text", text: "answer" },
    ] as never;
    expect(decodeContent(encodeContent(blocks))).toEqual(blocks);
  });

  it("reads a pre-migration plain-text row as one text block", () => {
    expect(decodeContent("plain text, not JSON")).toEqual([
      { type: "text", text: "plain text, not JSON" },
    ]);
  });

  it("reads stored JSON that is not an array as text", () => {
    // A row whose text happens to be valid JSON must not be mistaken for
    // wire format.
    expect(decodeContent('{"a":1}')).toEqual([
      { type: "text", text: '{"a":1}' },
    ]);
  });
});

describe("messageText", () => {
  it("joins text blocks and ignores tool calls, results and images", () => {
    const text = messageText([
      { type: "text", text: "first" },
      { type: "tool_use", id: "tu_1", name: "get_topic", input: {} },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
      { type: "text", text: "second" },
    ]);
    expect(text).toBe("first\n\nsecond");
  });

  it("returns a string unchanged", () => {
    expect(messageText("hi")).toBe("hi");
  });
});

describe("defaultKind", () => {
  it("classifies by role", () => {
    expect(defaultKind("user")).toBe("user_message");
    expect(defaultKind("assistant")).toBe("assistant_message");
  });
});

describe("isTerminalStopReason", () => {
  it("treats a finished response as terminal", () => {
    expect(isTerminalStopReason("end_turn")).toBe(true);
    expect(isTerminalStopReason("max_tokens")).toBe(true);
  });

  it("treats a mid-flight or missing reason as non-terminal", () => {
    expect(isTerminalStopReason("tool_use")).toBe(false);
    expect(isTerminalStopReason("pause_turn")).toBe(false);
    expect(isTerminalStopReason(null)).toBe(false);
  });
});

describe("conversationHasWork", () => {
  it("is false for an empty conversation", () => {
    expect(conversationHasWork({ pendingCount: 0 })).toBe(false);
  });

  it("is true whenever messages are queued", () => {
    expect(
      conversationHasWork({
        pendingCount: 1,
        tail: { kind: "assistant_message", stopReason: "end_turn" },
      }),
    ).toBe(true);
  });

  it("is true for a user message or a tool result at the tail", () => {
    expect(
      conversationHasWork({
        pendingCount: 0,
        tail: { kind: "user_message", stopReason: null },
      }),
    ).toBe(true);
    expect(
      conversationHasWork({
        pendingCount: 0,
        tail: { kind: "tool_result", stopReason: null },
      }),
    ).toBe(true);
  });

  it("is false only for a finished assistant response with an empty queue", () => {
    expect(
      conversationHasWork({
        pendingCount: 0,
        tail: { kind: "assistant_message", stopReason: "end_turn" },
      }),
    ).toBe(false);
    expect(
      conversationHasWork({
        pendingCount: 0,
        tail: { kind: "assistant_message", stopReason: "tool_use" },
      }),
    ).toBe(true);
  });
});
