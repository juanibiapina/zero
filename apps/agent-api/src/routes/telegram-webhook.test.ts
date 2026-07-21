import { describe, expect, it, vi } from "vitest";
import {
  resolveContext,
  extractAttachment,
  refineFilename,
  processTelegramMessage,
  type WebhookDeps,
  type EnqueueTurnInput,
} from "./telegram-webhook";
import { createMemoryAttachments } from "../attachments/memory";
import type { TopicContext } from "../telegram/context";

describe("resolveContext", () => {
  it("returns topicId from forum supergroup topic message", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
      is_topic_message: true,
      message_thread_id: 42,
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 42,
    });
  });

  it("returns topicId from DM with topics enabled", () => {
    const result = resolveContext(111, {
      chat: { type: "private", id: 100 },
      is_topic_message: true,
      message_thread_id: 7,
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 7,
    });
  });

  it("returns topicId=0 for plain DM without topics", () => {
    const result = resolveContext(111, {
      chat: { type: "private", id: 100 },
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 0,
    });
  });

  it("drops group chat message (not a topic)", () => {
    const result = resolveContext(111, {
      chat: { type: "group", id: 100 },
    });
    expect(result).toBeNull();
  });

  it("drops supergroup message without topic", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
    });
    expect(result).toBeNull();
  });

  it("drops channel message", () => {
    const result = resolveContext(111, {
      chat: { type: "channel", id: 100 },
    });
    expect(result).toBeNull();
  });
});

describe("extractAttachment", () => {
  it("returns null when no attachment present", () => {
    expect(extractAttachment({})).toBeNull();
  });

  it("picks the largest photo (last in array) with synthesized name", () => {
    const result = extractAttachment({
      photo: [
        { file_id: "small", file_unique_id: "u1" },
        { file_id: "large", file_unique_id: "u2" },
      ],
    });
    expect(result).toEqual({
      file_id: "large",
      fileUniqueId: "u2",
      filename: "photo_u2.jpg",
      mimeType: "image/jpeg",
      kind: "photo",
    });
  });

  it("prefers photo over a back-compat double-set field", () => {
    // live_photo also sets photo; photo must win.
    const result = extractAttachment({
      photo: [{ file_id: "p", file_unique_id: "up" }],
      document: { file_id: "d", file_unique_id: "ud" },
    });
    expect(result?.file_id).toBe("p");
  });

  it("reads an animation, not the back-compat document field", () => {
    // animation also sets document; animation must win.
    const result = extractAttachment({
      animation: { file_id: "anim", file_unique_id: "ua", mime_type: "video/mp4" },
      document: { file_id: "doc", file_unique_id: "ud", mime_type: "video/mp4" },
    });
    expect(result?.file_id).toBe("anim");
    expect(result?.filename).toBe("animation_ua.mp4");
  });

  it("uses the client file_name for a document", () => {
    const result = extractAttachment({
      document: { file_id: "d", file_unique_id: "ud", file_name: "report.pdf", mime_type: "application/pdf" },
    });
    expect(result).toEqual({
      file_id: "d",
      fileUniqueId: "ud",
      filename: "report.pdf",
      mimeType: "application/pdf",
      kind: "document",
    });
  });

  it("sanitizes a path-traversal file_name to a basename", () => {
    const result = extractAttachment({
      document: { file_id: "d", file_unique_id: "ud", file_name: "../../etc/passwd", mime_type: "text/plain" },
    });
    expect(result?.filename).toBe("passwd");
  });

  it("synthesizes a generic document name without file_name", () => {
    const result = extractAttachment({
      document: { file_id: "d", file_unique_id: "ud" },
    });
    expect(result?.filename).toBe("document_ud");
    expect(result?.mimeType).toBe("application/octet-stream");
  });

  it("names a voice note .ogg", () => {
    const result = extractAttachment({
      voice: { file_id: "v", file_unique_id: "uv" },
    });
    expect(result).toEqual({
      file_id: "v",
      fileUniqueId: "uv",
      filename: "voice_uv.ogg",
      mimeType: "audio/ogg",
      kind: "voice",
    });
  });

  it("names a sticker .webp", () => {
    const result = extractAttachment({
      sticker: { file_id: "s", file_unique_id: "us" },
    });
    expect(result).toEqual({
      file_id: "s",
      fileUniqueId: "us",
      filename: "sticker_us.webp",
      mimeType: "image/webp",
      kind: "sticker",
    });
  });
});

describe("refineFilename", () => {
  it("keeps a name that already has an extension", () => {
    expect(refineFilename("report.pdf", "documents/file_42.pdf")).toBe("report.pdf");
  });

  it("borrows the extension from file_path when missing", () => {
    expect(refineFilename("document_ud", "documents/file_42.pdf")).toBe("document_ud.pdf");
  });

  it("leaves the name unchanged when file_path has no extension", () => {
    expect(refineFilename("document_ud", "documents/file_42")).toBe("document_ud");
  });
});

describe("processTelegramMessage", () => {
  const topic: TopicContext = { telegramId: "111", chatId: 100, topicId: 0 };

  const makeDeps = (over: Partial<WebhookDeps> = {}) => {
    const enqueued: Array<{ clerkUserId: string; input: EnqueueTurnInput }> = [];
    const replies: string[] = [];
    const attachments = createMemoryAttachments();
    const deps: WebhookDeps = {
      attachments,
      download: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        filePath: "photos/file_1.jpg",
      })),
      getClerkUserId: async () => "user_1",
      enqueue: async (clerkUserId, input) => {
        enqueued.push({ clerkUserId, input });
      },
      sendReply: async (_c, _t, text) => {
        replies.push(text);
      },
      sendTyping: async () => {},
      ...over,
    };
    return { deps, enqueued, replies, attachments };
  };

  const photoMsg = (caption?: string) => ({
    photo: [{ file_id: "large", file_unique_id: "u2" }],
    ...(caption ? { caption } : {}),
  });

  it("downloads a photo to R2, enqueues with a marker, and sends no notice", async () => {
    const { deps, enqueued, replies, attachments } = makeDeps();
    await processTelegramMessage(deps, topic, photoMsg(), "1");

    expect(replies).toEqual([]);
    expect(enqueued).toHaveLength(1);
    const input = enqueued[0].input;
    expect(input.text).toMatch(/^\[image "photo_u2\.jpg" id=att_.+\]$/);
    expect(input.attachments).toHaveLength(1);
    const row = input.attachments![0];
    expect(row.r2Key).toBe("attachments/user_1/u2");
    // The marker id matches the persisted row id.
    expect(input.text).toContain(row.id);
    // Bytes landed in the store under the row key.
    expect(await attachments.get(row.r2Key)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("keeps the caption alongside the marker", async () => {
    const { deps, enqueued } = makeDeps();
    await processTelegramMessage(deps, topic, photoMsg("what is this?"), "1");

    const text = enqueued[0].input.text;
    expect(text).toContain("what is this?");
    expect(text).toMatch(/\[image "photo_u2\.jpg" id=att_.+\]/);
  });

  it("skips an oversize image with a notice and no enqueue", async () => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({
        bytes: new Uint8Array(6 * 1024 * 1024),
        filePath: "photos/file_1.jpg",
      })),
    });
    await processTelegramMessage(deps, topic, photoMsg(), "1");

    expect(enqueued).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("too large");
  });

  it("processes the caption of an oversize image but drops the image", async () => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({
        bytes: new Uint8Array(6 * 1024 * 1024),
        filePath: "photos/file_1.jpg",
      })),
    });
    await processTelegramMessage(deps, topic, photoMsg("caption"), "1");

    expect(replies[0]).toContain("too large");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input.text).toBe("caption");
    expect(enqueued[0].input.attachments).toBeUndefined();
  });

  it("notices and skips a non-image attachment with no text", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      { document: { file_id: "d", file_unique_id: "ud", mime_type: "application/pdf" } },
      "1",
    );

    expect(enqueued).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("can't handle");
  });

  it("processes text and notes the ignored file for a non-image attachment with a caption", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      {
        document: { file_id: "d", file_unique_id: "ud", mime_type: "application/pdf" },
        caption: "see attached",
      },
      "1",
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input.text).toBe("see attached");
    expect(enqueued[0].input.attachments).toBeUndefined();
    expect(replies.some((r) => r.includes("ignored"))).toBe(true);
  });

  it("treats a sticker as a non-image attachment", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      { sticker: { file_id: "s", file_unique_id: "us" } },
      "1",
    );

    expect(enqueued).toEqual([]);
    expect(replies[0]).toContain("can't handle");
  });

  it("enqueues a plain text message unchanged", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(deps, topic, { text: "hello" }, "1");

    expect(replies).toEqual([]);
    expect(enqueued[0].input.text).toBe("hello");
    expect(enqueued[0].input.attachments).toBeUndefined();
  });

  it("drops a message with no content and no attachment", async () => {
    const { deps, enqueued } = makeDeps();
    await processTelegramMessage(deps, topic, {}, "1");
    expect(enqueued).toEqual([]);
  });

  it("drops when the telegram id is unknown", async () => {
    const { deps, enqueued } = makeDeps({ getClerkUserId: async () => null });
    await processTelegramMessage(deps, topic, photoMsg(), "1");
    expect(enqueued).toEqual([]);
  });
});
