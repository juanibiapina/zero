import { describe, expect, it } from "vitest";
import {
  fromWireOutput,
  reasoningTokens,
  toStopReason,
  toUsage,
  toWireInput,
  toWireTools,
  type WireItem,
  type WireResponse,
} from "./openai-wire";
import type { AgentMessage, ContentBlock, TextBlock } from "./protocol";

const system = (...texts: string[]): TextBlock[] =>
  texts.map((text) => ({ type: "text", text }));

const marked = (block: TextBlock): TextBlock => ({
  ...block,
  cache_control: { type: "ephemeral", ttl: "1h" },
});

describe("toWireTools", () => {
  it("maps definitions in order without a cache breakpoint", () => {
    expect(
      toWireTools([
        {
          name: "get_topic",
          description: "read a topic",
          input_schema: { type: "object", properties: { id: {} } },
          // Tools cannot carry a breakpoint on this API; a marked definition
          // must not smuggle one onto the wire.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        { name: "reply", description: "say something", input_schema: { type: "object" } },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "get_topic",
        description: "read a topic",
        parameters: { type: "object", properties: { id: {} } },
        strict: false,
      },
      {
        type: "function",
        name: "reply",
        description: "say something",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
  });
});

describe("toWireInput", () => {
  it("puts the system blocks in a leading developer message", () => {
    const items = toWireInput(
      [marked(system("instructions")[0]), marked(system("pinned")[0])],
      [],
    );
    expect(items).toEqual([
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "instructions",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
          {
            type: "input_text",
            text: "pinned",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ]);
  });

  it("promotes a string user message to an input_text block", () => {
    expect(toWireInput([], [{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("sends images as data URLs", () => {
    const message: AgentMessage = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAA" },
        },
      ],
    };
    expect(toWireInput([], [message])).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
    ]);
  });

  it("maps assistant text to assistant items and preserves phase", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "thinking out loud", phase: "commentary" },
        { type: "text", text: "the answer", phase: "final_answer" },
      ],
    };
    expect(toWireInput([], [message])).toEqual([
      { role: "assistant", content: "thinking out loud", phase: "commentary" },
      { role: "assistant", content: "the answer", phase: "final_answer" },
    ]);
  });

  it("maps a tool call and its result to a call/output pair keyed by call id", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "get_topic", input: { id: "t" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "body" },
        ],
      },
    ];
    expect(toWireInput([], messages)).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_topic",
        arguments: JSON.stringify({ id: "t" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: "body" }],
      },
    ]);
  });

  it("carries image tool results as image output, not a placeholder", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: [
              { type: "text", text: "here it is" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "BBB" },
              },
            ],
          },
        ],
      },
    ];
    expect(toWireInput([], messages)).toEqual([
      {
        type: "function_call_output",
        call_id: "call_2",
        output: [
          { type: "input_text", text: "here it is" },
          { type: "input_image", image_url: "data:image/jpeg;base64,BBB" },
        ],
      },
    ]);
  });

  it("splits a message that mixes tool results with text, keeping order", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_3", content: "out" },
          { type: "text", text: "and now this" },
        ],
      },
    ];
    expect(toWireInput([], messages).map((i) => itemKind(i))).toEqual([
      "function_call_output",
      "user",
    ]);
  });

  it("moves a breakpoint on a tool result onto its last output block", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_4",
            content: "out",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ];
    expect(toWireInput([], messages)).toEqual([
      {
        type: "function_call_output",
        call_id: "call_4",
        output: [
          {
            type: "input_text",
            text: "out",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ]);
  });

  describe("reasoning replay", () => {
    const reasoning = (over: Record<string, unknown> = {}): ContentBlock => ({
      type: "thinking",
      thinking: "",
      signature: "",
      id: "rs_1",
      encrypted_content: "cipher",
      ...over,
    });

    it("replays a reasoning block that is followed by its output", () => {
      const message: AgentMessage = {
        role: "assistant",
        content: [reasoning(), { type: "text", text: "answer" }],
      };
      expect(toWireInput([], [message])[0]).toEqual({
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "cipher",
      });
    });

    // A window can open on a compaction boundary or a paged read, leaving
    // reasoning whose item is gone. The API rejects that outright, so it is
    // dropped rather than sent.
    it("drops an orphan reasoning block with nothing after it", () => {
      const message: AgentMessage = {
        role: "assistant",
        content: [reasoning()],
      };
      expect(toWireInput([], [message])).toEqual([]);
    });

    // Conversations written before the provider switch carry Anthropic
    // signatures, which cannot be replayed here.
    it("drops reasoning from the other provider", () => {
      const message: AgentMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "text", text: "answer" },
        ],
      };
      expect(toWireInput([], [message])).toEqual([
        { role: "assistant", content: "answer" },
      ]);
    });

    it("drops a redacted thinking block", () => {
      const message: AgentMessage = {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
      };
      expect(toWireInput([], [message])).toEqual([
        { role: "assistant", content: "answer" },
      ]);
    });
  });
});

const itemKind = (item: WireItem): string =>
  "type" in item ? item.type : item.role;

describe("fromWireOutput", () => {
  it("reads text, phase, tool calls and reasoning back into blocks", () => {
    expect(
      fromWireOutput([
        { type: "reasoning", id: "rs_1", encrypted_content: "cipher" },
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "done" }],
        },
        {
          type: "function_call",
          call_id: "call_9",
          name: "reply",
          arguments: '{"text":"hi"}',
        },
      ]),
    ).toEqual([
      {
        type: "thinking",
        thinking: "",
        signature: "",
        id: "rs_1",
        encrypted_content: "cipher",
      },
      { type: "text", text: "done", phase: "final_answer" },
      { type: "tool_use", id: "call_9", name: "reply", input: { text: "hi" } },
    ]);
  });

  it("drops a reasoning item with no encrypted content, which cannot be replayed", () => {
    expect(fromWireOutput([{ type: "reasoning", id: "rs_2" }])).toEqual([]);
  });

  it("turns a refusal into text so the user still sees it", () => {
    expect(
      fromWireOutput([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I can't help with that" }],
        },
      ]),
    ).toEqual([{ type: "text", text: "I can't help with that" }]);
  });

  it("survives unparsable tool arguments by handing the tool an empty input", () => {
    expect(
      fromWireOutput([
        { type: "function_call", call_id: "c", name: "reply", arguments: "{oops" },
      ]),
    ).toEqual([{ type: "tool_use", id: "c", name: "reply", input: {} }]);
  });

  it("ignores item types Zero does not model", () => {
    expect(fromWireOutput([{ type: "web_search_call" }])).toEqual([]);
  });
});

describe("toStopReason", () => {
  const response = (over: Partial<WireResponse>): WireResponse => ({
    id: "resp_1",
    status: "completed",
    output: [],
    ...over,
  });

  it("reports tool_use whenever the model asked for a function", () => {
    expect(
      toStopReason(
        response({
          output: [
            { type: "message", content: [{ type: "output_text", text: "one sec" }] },
            { type: "function_call", call_id: "c", name: "n", arguments: "{}" },
          ],
        }),
      ),
    ).toBe("tool_use");
  });

  it("maps a completed response to end_turn", () => {
    expect(toStopReason(response({}))).toBe("end_turn");
  });

  it("maps an output-token cutoff to max_tokens", () => {
    expect(
      toStopReason(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    ).toBe("max_tokens");
  });

  it("maps a refusal", () => {
    expect(
      toStopReason(
        response({
          output: [
            { type: "message", content: [{ type: "refusal", refusal: "no" }] },
          ],
        }),
      ),
    ).toBe("refusal");
  });

  it("reports null for a state it cannot classify", () => {
    expect(toStopReason(response({ status: "in_progress" }))).toBeNull();
  });
});

describe("toUsage", () => {
  it("subtracts cached tokens from input and books writes to the 5m tier", () => {
    expect(
      toUsage({
        id: "r",
        usage: {
          input_tokens: 1000,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 60 },
          output_tokens_details: { reasoning_tokens: 25 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 60,
      cacheWrite5mTokens: 60,
      cacheWrite1hTokens: 0,
    });
  });

  it("reads zeros from a response with no usage", () => {
    expect(toUsage({ id: "r" })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });

  it("never reports negative uncached input", () => {
    expect(
      toUsage({
        id: "r",
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
      }).inputTokens,
    ).toBe(0);
  });

  it("reads reasoning tokens", () => {
    expect(
      reasoningTokens({
        id: "r",
        usage: { output_tokens_details: { reasoning_tokens: 25 } },
      }),
    ).toBe(25);
    expect(reasoningTokens({ id: "r" })).toBe(0);
  });
});
