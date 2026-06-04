import { describe, expect, it } from "vitest";
import { resolveContext, extractAttachment, refineFilename } from "./telegram-webhook";

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
      filename: "photo_u2.jpg",
      mimeType: "image/jpeg",
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
      filename: "report.pdf",
      mimeType: "application/pdf",
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
      filename: "voice_uv.ogg",
      mimeType: "audio/ogg",
    });
  });

  it("names a sticker .webp", () => {
    const result = extractAttachment({
      sticker: { file_id: "s", file_unique_id: "us" },
    });
    expect(result).toEqual({
      file_id: "s",
      filename: "sticker_us.webp",
      mimeType: "image/webp",
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
