import { describe, expect, it } from "vitest";
import {
  applyStalenessFilter,
  conversationHasWork,
  decodeContent,
  defaultKind,
  encodeContent,
  isTerminalStopReason,
  messageText,
  safeCompactionCut,
  STALE_TOPIC_STUB,
  trimOrphanToolResults,
  unclaimedBlockIndexes,
} from "./messages";
import type { ContentBlock } from "../agents/protocol";
import type { Message, MessageKind, Role } from "./types";

describe("content encoding", () => {
  it("round-trips a string as one text block", () => {
    expect(decodeContent(encodeContent("hi"))).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  // A thinking signature that survives a store round trip byte-for-byte is what
  // lets a resumed turn hand the model back its own reasoning.
  it("round-trips thinking blocks with their signatures intact", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", signature: "sig", thinking: "" },
      { type: "redacted_thinking", data: "encrypted" },
      { type: "text", text: "answer" },
    ];
    expect(decodeContent(encodeContent(blocks))).toEqual(blocks);
  });

  it("round-trips blocks verbatim, including unknown block types", () => {
    const blocks = [
      { type: "server_tool_use", id: "srv_1", name: "web_search" },
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

  // messageText is what every prose surface reads (compaction prompts,
  // transcripts), so reasoning must not be able to reach them through it.
  it("ignores thinking blocks", () => {
    expect(
      messageText([
        { type: "thinking", thinking: "私の推論", signature: "sig" },
        { type: "redacted_thinking", data: "encrypted" },
        { type: "text", text: "the answer" },
      ]),
    ).toBe("the answer");
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

  it("is true for a finished response whose text was never sent", () => {
    expect(
      conversationHasWork({
        pendingCount: 0,
        tail: { kind: "assistant_message", stopReason: "end_turn" },
        undeliveredCount: 1,
      }),
    ).toBe(true);
  });
});

describe("unclaimedBlockIndexes", () => {
  it("lists text blocks that carry something to say and were not claimed", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "one" },
      { type: "text", text: "   " },
      { type: "tool_use", id: "tu_1", name: "get_topic", input: {} },
      { type: "text", text: "two" },
    ];
    expect(unclaimedBlockIndexes(content, [])).toEqual([0, 3]);
    expect(unclaimedBlockIndexes(content, [0])).toEqual([3]);
    expect(unclaimedBlockIndexes(content, [0, 3])).toEqual([]);
  });

  // A delivery claim is keyed by block index, so a leading thinking block shifts
  // every text block along. Claims are computed from the same stored array, so
  // the two stay in step and nothing is re-sent after a reset.
  it("indexes text blocks past a leading thinking block", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ];
    expect(unclaimedBlockIndexes(content, [])).toEqual([1, 2]);
    expect(unclaimedBlockIndexes(content, [1])).toEqual([2]);
  });
});

describe("safeCompactionCut", () => {
  const row = (kind: MessageKind, stopReason: string | null = null) => ({
    kind,
    stopReason,
  });

  it("cuts after the newest terminal assistant response", () => {
    const rows = [
      row("user_message"),
      row("assistant_message", "end_turn"),
      row("user_message"),
      row("assistant_message", "end_turn"),
    ];
    expect(safeCompactionCut(rows, { keepTail: 0 })).toBe(3);
  });

  it("never cuts between a tool call and its result", () => {
    const rows = [
      row("user_message"),
      row("assistant_message", "end_turn"),
      row("user_message"),
      row("assistant_message", "tool_use"),
      row("tool_result"),
      row("assistant_message", "end_turn"),
    ];
    // A row count would cut at index 3 or 4 and orphan the result.
    expect(safeCompactionCut(rows, { keepTail: 2 })).toBe(1);
  });

  it("is null when the window holds no finished response", () => {
    const rows = [row("assistant_message", "tool_use"), row("tool_result")];
    expect(safeCompactionCut(rows, { keepTail: 0 })).toBeNull();
  });

  it("holds the newest rows out of the summary", () => {
    const rows = [
      row("assistant_message", "end_turn"),
      row("user_message"),
      row("assistant_message", "end_turn"),
    ];
    expect(safeCompactionCut(rows, { keepTail: 0 })).toBe(2);
    expect(safeCompactionCut(rows, { keepTail: 2 })).toBe(0);
  });
});

describe("trimOrphanToolResults", () => {
  it("drops leading results whose call was cut away", () => {
    const rows = [
      { kind: "tool_result" as MessageKind },
      { kind: "tool_result" as MessageKind },
      { kind: "user_message" as MessageKind },
    ];
    expect(trimOrphanToolResults(rows)).toEqual([{ kind: "user_message" }]);
  });

  it("keeps a window that opens on an assistant row with its own calls", () => {
    const rows = [
      { kind: "assistant_message" as MessageKind },
      { kind: "tool_result" as MessageKind },
    ];
    expect(trimOrphanToolResults(rows)).toEqual(rows);
  });
});

const msg = (id: number, content: Message["content"], role: Role = "user"): Message => ({
  id,
  role,
  kind: role === "assistant" ? "assistant_message" : "user_message",
  content,
  stopReason: null,
  responseId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
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
