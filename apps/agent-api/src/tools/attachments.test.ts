import { describe, expect, it } from "vitest";
import { buildAttachmentTool } from "./attachments";
import { runAgent } from "../agents/run";
import { capturingModel } from "../agents/mock-model";
import type {
  AgentModelRequest,
  ToolResultBlock,
} from "../agents/protocol";
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

// The tool object exposes execute + toContent; call them directly to test
// behavior without a model in the loop.
type ViewTool = {
  execute: (args: { id: string }) => Promise<unknown>;
  toContent: (output: unknown) => unknown;
};

describe("view_attachment", () => {
  it("returns base64 image data for a known id", async () => {
    const { store, attachments } = await seed();
    const tool = buildAttachmentTool({
      attachments,
      getAttachment: (id) => store.getAttachment(id),
    }).view_attachment as unknown as ViewTool;

    const output = await tool.execute({ id: "att_1" });
    expect(output).toEqual({ data: PNG_B64, mediaType: "image/png" });
    expect(tool.toContent(output)).toEqual({
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
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

    const output = await tool.execute({ id: "ghost" });
    expect(output).toEqual({ error: "No attachment found for id ghost." });
    expect(tool.toContent(output)).toEqual({
      content: "No attachment found for id ghost.",
      isError: true,
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

    expect(await tool.execute({ id: "att_1" })).toEqual({
      error: "No attachment found for id att_1.",
    });
  });

  // Regression spike: the loop must put the tool's image output into a real
  // Anthropic `tool_result` image block (base64 image source), not a
  // stringified blob, and the writer's transcript must never carry the base64.
  it("serializes the image into an Anthropic tool_result image block", async () => {
    const { store, attachments } = await seed();
    const requests: AgentModelRequest[] = [];
    let call = 0;
    const model = capturingModel((request) => {
      requests.push(structuredClone(request));
      return call++ === 0
        ? {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "view_attachment",
                input: { id: "att_1" },
              },
            ],
            stopReason: "tool_use",
          }
        : {
            content: [{ type: "text", text: "It's a cat." }],
            stopReason: "end_turn",
          };
    });

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "what is in the image att_1",
      tools: buildAttachmentTool({
        attachments,
        getAttachment: (id) => store.getAttachment(id),
      }),
    });

    expect(result.text).toBe("It's a cat.");
    // The second request carries the tool_result with an image block.
    const toolResult = requests[1].messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(toolResult?.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_B64 },
      },
    ]);
  });
});
