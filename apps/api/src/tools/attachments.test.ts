import { describe, expect, it, vi } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { buildAttachmentTool } from "./attachments";
import { runAgent } from "../agents/run";
import { MemoryStore } from "../store/memory";
import { createMemoryAttachments } from "../attachments/memory";
import { attachmentKey } from "../attachments/types";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

const seed = async () => {
  const store = new MemoryStore();
  const attachments = createMemoryAttachments();
  const conv = store.getOrCreateConversation(1, 0);
  const r2Key = attachmentKey("user_1", "abc");
  store.putAttachment({
    id: "att_1",
    conversationId: conv,
    r2Key,
    filename: "cat.png",
    mimeType: "image/png",
  });
  await attachments.put(r2Key, PNG, "image/png");
  return { store, attachments };
};

// The tool object exposes execute + toModelOutput; call them directly to test
// behavior without a model in the loop.
type ViewTool = {
  execute: (args: { id: string }, opts: unknown) => Promise<unknown>;
  toModelOutput: (arg: { output: unknown }) => unknown;
};

describe("view_attachment", () => {
  it("returns base64 image data for a known id", async () => {
    const { store, attachments } = await seed();
    const tool = buildAttachmentTool({
      attachments,
      getAttachment: (id) => store.getAttachment(id),
    }).view_attachment as unknown as ViewTool;

    const output = await tool.execute({ id: "att_1" }, {});
    expect(output).toEqual({ data: PNG_B64, mediaType: "image/png" });
    expect(tool.toModelOutput({ output })).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: { type: "data", data: PNG_B64 },
          mediaType: "image/png",
        },
      ],
    });
  });

  it("returns an error for an unknown id", async () => {
    const { store, attachments } = await seed();
    const tool = buildAttachmentTool({
      attachments,
      getAttachment: (id) => store.getAttachment(id),
    }).view_attachment as unknown as ViewTool;

    const output = await tool.execute({ id: "ghost" }, {});
    expect(output).toEqual({ error: "No attachment found for id ghost." });
    expect(tool.toModelOutput({ output })).toEqual({
      type: "error-text",
      value: "No attachment found for id ghost.",
    });
  });

  it("is user-scoped: an id resolvable only via getAttachment cannot cross users", async () => {
    const { attachments } = await seed();
    // A store that knows no attachments (a different user's DO) resolves nothing,
    // so the bytes are never reachable even though R2 holds them.
    const tool = buildAttachmentTool({
      attachments,
      getAttachment: () => null,
    }).view_attachment as unknown as ViewTool;

    expect(await tool.execute({ id: "att_1" }, {})).toEqual({
      error: "No attachment found for id att_1.",
    });
  });

  // Regression spike: the AI SDK must serialize the tool's `file` output into a
  // real Anthropic `tool_result` image block (base64 image source), not a
  // stringified blob. Intercept the provider's fetch to inspect the second
  // request body. Guards against an AI SDK / provider upgrade breaking it.
  it("serializes the image into an Anthropic tool_result image block", async () => {
    const { store, attachments } = await seed();
    const bodies: unknown[] = [];
    let call = 0;
    const fakeFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      call++;
      if (call === 1) {
        // First response: the model calls view_attachment.
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "view_attachment",
                input: { id: "att_1" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Second response: the model answers from the image.
      return new Response(
        JSON.stringify({
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "It's a cat." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const anthropic = createAnthropic({
      apiKey: "test",
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const result = await runAgent({
      model: anthropic("claude-sonnet-4-6"),
      system: "sys",
      prompt: "what is in the image att_1",
      tools: buildAttachmentTool({
        attachments,
        getAttachment: (id) => store.getAttachment(id),
      }),
    });

    expect(result.text).toBe("It's a cat.");
    // The second request carries the tool_result with an image block.
    const second = bodies[1] as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };
    const parts = second.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const toolResult = parts.find((p) => p.type === "tool_result") as {
      content: Array<{
        type: string;
        source?: { type: string; media_type: string; data: string };
      }>;
    };
    expect(toolResult).toBeTruthy();
    const image = toolResult.content.find((c) => c.type === "image");
    expect(image?.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: PNG_B64,
    });
  });
});
