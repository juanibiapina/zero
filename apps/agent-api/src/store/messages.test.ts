import { describe, expect, it } from "vitest";
import {
  applyContextBackstop,
  applyStalenessFilter,
  conversationHasWork,
  decodeContent,
  defaultKind,
  encodeContent,
  isTerminalStopReason,
  messageText,
  STALE_TOPIC_STUB,
} from "./messages";
import type { Message, Role } from "./types";

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

const msg = (id: number, content: Message["content"], role: Role = "user"): Message => ({
  id,
  role,
  kind: role === "assistant" ? "assistant_message" : "user_message",
  content,
  stopReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("context backstop", () => {
  it("keeps everything under the ceiling", () => {
    const messages = [msg(1, "a"), msg(2, "b")];
    expect(applyContextBackstop(messages, 100)).toBe(messages);
  });

  it("drops the oldest messages until the context fits", () => {
    const messages = [msg(1, "aaaa"), msg(2, "bbbb"), msg(3, "cc")];
    expect(
      applyContextBackstop(messages, 8).map((m) => messageText(m.content)),
    ).toEqual(["bbbb", "cc"]);
  });

  it("never drops the newest message, however large it is", () => {
    const messages = [msg(1, "aaaa"), msg(2, "b".repeat(100))];
    expect(applyContextBackstop(messages, 10).map((m) => m.id)).toEqual([2]);
  });
});

describe("staleness filter", () => {
  const readCall = msg(
    1,
    [{ type: "tool_use", id: "tu_1", name: "get_topic", input: { name: "a" } }],
    "assistant",
  );
  const readResult = (version: number) =>
    msg(2, [
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: JSON.stringify({ version, topic: { name: "a", body: "old" } }),
      },
    ]);

  it("keeps a topic read taken at the current version", () => {
    const input = [readCall, readResult(7)];
    const { messages, stubbed } = applyStalenessFilter(input, 7);
    expect(stubbed).toBe(0);
    expect(messages).toEqual(input);
  });

  it("replaces a stale topic read with a stub, keeping the tool pair", () => {
    const { messages, stubbed } = applyStalenessFilter(
      [readCall, readResult(6)],
      7,
    );
    expect(stubbed).toBe(1);
    expect(messages[0]).toEqual(readCall);
    expect(messages[1].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: STALE_TOPIC_STUB },
    ]);
  });

  it("stubs a result that carries no version at all", () => {
    const noVersion = msg(2, [
      { type: "tool_result", tool_use_id: "tu_1", content: "topic a" },
    ]);
    const { stubbed } = applyStalenessFilter([readCall, noVersion], 7);
    expect(stubbed).toBe(1);
  });

  it("leaves results of tools that are not topic reads alone", () => {
    const call = msg(
      1,
      [{ type: "tool_use", id: "tu_2", name: "research", input: {} }],
      "assistant",
    );
    const result = msg(2, [
      { type: "tool_result", tool_use_id: "tu_2", content: "findings" },
    ]);
    const { messages, stubbed } = applyStalenessFilter([call, result], 7);
    expect(stubbed).toBe(0);
    expect(messages[1]).toEqual(result);
  });
});
