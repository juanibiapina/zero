import { describe, expect, it, vi } from "vitest";
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

type PdfTool = {
  execute: (args: { id: string; start_page?: number; end_page?: number }) => Promise<unknown>;
  toContent: (output: unknown) => unknown;
};

const seedPdf = async () => {
  const store = new MemoryStore();
  const attachments = createMemoryAttachments();
  const conv = store.getOrCreateConversation(1, 0);
  const r2Key = attachmentKey("user_1", "pdf");
  store.putAttachment({
    id: "att_pdf",
    conversationId: conv,
    r2Key,
    filename: "report.pdf",
    mimeType: "application/pdf",
  });
  await attachments.put(r2Key, new Uint8Array([37, 80, 68, 70]), "application/pdf");
  return { store, attachments };
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

describe("read_pdf", () => {
  it("returns page-labelled text for a known user-scoped PDF", async () => {
    const { store, attachments } = await seedPdf();
    const readPdf = vi.fn(async () => ({
      totalPages: 42,
      startPage: 1,
      endPage: 20,
      pages: [{ page: 1, text: "Quarterly revenue" }],
      truncated: true,
    }));
    const tool = buildAttachmentTool({
      attachments,
      getAttachment: (id) => store.getAttachment(id),
      readPdf,
    }).read_pdf as unknown as PdfTool;

    const output = await tool.execute({ id: "att_pdf" });
    const content = tool.toContent(output) as { content: string };
    expect(content.content).toContain('PDF "report.pdf", pages 1-20 of 42');
    expect(content.content).toContain("--- Page 1 ---\nQuarterly revenue");
    expect(content.content).toContain("start_page=21");
    expect(readPdf).toHaveBeenCalledWith(expect.any(Uint8Array), { startPage: undefined, endPage: undefined });
  });

  it("rejects unknown attachments and non-PDF MIME types", async () => {
    const { store, attachments } = await seed();
    const tools = buildAttachmentTool({ attachments, getAttachment: (id) => store.getAttachment(id) });
    const pdf = tools.read_pdf as unknown as PdfTool;
    expect(await pdf.execute({ id: "ghost" })).toEqual({ error: "No attachment found for id ghost." });
    expect(await pdf.execute({ id: "att_1" })).toEqual({ error: "Attachment att_1 is not a PDF." });
  });

  it("puts extracted text in the next model request and persists no PDF bytes", async () => {
    const { store, attachments } = await seedPdf();
    const requests: AgentModelRequest[] = [];
    const readPdf = vi.fn(async () => ({
      totalPages: 1,
      startPage: 1,
      endPage: 1,
      pages: [{ page: 1, text: "Durable extracted text" }],
      truncated: false,
    }));
    let call = 0;
    const model = capturingModel((request) => {
      requests.push(structuredClone(request));
      return call++ === 0
        ? { content: [{ type: "tool_use", id: "toolu_pdf", name: "read_pdf", input: { id: "att_pdf" } }], stopReason: "tool_use" }
        : { content: [{ type: "text", text: "Summary" }], stopReason: "end_turn" };
    });

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "summarize the PDF",
      tools: buildAttachmentTool({ attachments, getAttachment: (id) => store.getAttachment(id), readPdf }),
    });
    const serialized = JSON.stringify(requests[1]);
    expect(serialized).toContain("Durable extracted text");
    expect(serialized).not.toContain("base64");
    expect(JSON.stringify(result.messages)).toContain("Durable extracted text");
    expect(JSON.stringify(result.messages)).not.toContain("JVBER");

    const replayModel = capturingModel(() => ({
      content: [{ type: "text", text: "Replayed summary" }],
      stopReason: "end_turn",
    }));
    await runAgent({ model: replayModel, system: "sys", messages: result.messages, tools: buildAttachmentTool({ attachments, getAttachment: (id) => store.getAttachment(id), readPdf }) });
    expect(readPdf).toHaveBeenCalledTimes(1);
  });
});
