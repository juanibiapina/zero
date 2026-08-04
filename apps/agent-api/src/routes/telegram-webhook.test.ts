import { describe, expect, it, vi } from "vitest";
import {
  resolveContext,
  extractAttachment,
  refineFilename,
  processTelegramMessage,
  createTelegramWebhookRoute,
  MAX_ATTACHMENT_BYTES,
  type WebhookDeps,
  type EnqueueTurnInput,
} from "./telegram-webhook";
import type { TopicContext } from "../telegram/context";
import { SIGN_IN_REPLY } from "../commands/start";

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

  it("returns topicId=0 for a plain group message", () => {
    const result = resolveContext(111, {
      chat: { type: "group", id: 100 },
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 0,
    });
  });

  it("returns topicId=0 for a forum's General tab (no is_topic_message)", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 0,
    });
  });

  it("ignores message_thread_id on a reply in General (thread id is invalid for sending)", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
      message_thread_id: 55,
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 0,
    });
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

  it("picks the last photo candidate, with a synthesized name", () => {
    const result = extractAttachment({
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 320, height: 240 },
        { file_id: "large", file_unique_id: "u2", width: 1280, height: 960 },
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
      photo: [{ file_id: "p", file_unique_id: "up", width: 90, height: 60 }],
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
    const deps: WebhookDeps = {
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
    return { deps, enqueued, replies };
  };

  const photoMsg = (caption?: string) => ({
    photo: [
      { file_id: "large", file_unique_id: "u2", width: 1280, height: 960 },
    ],
    ...(caption ? { caption } : {}),
  });

  it("downloads a photo and hands its bytes to UserDO", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(deps, topic, photoMsg(), "1");

    expect(replies).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input.text).toBe("");
    expect(enqueued[0].input.files).toEqual([{
      filename: "photo_u2.jpg",
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
    }]);
  });

  it("keeps the caption alongside the downloaded file", async () => {
    const { deps, enqueued } = makeDeps();
    await processTelegramMessage(deps, topic, photoMsg("what is this?"), "1");

    expect(enqueued[0].input.text).toBe("what is this?");
    expect(enqueued[0].input.files).toHaveLength(1);
  });

  it("rejects a declared oversize file before downloading", async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1]), filePath: "file.bin" }));
    const { deps, enqueued, replies } = makeDeps({ download });
    await processTelegramMessage(deps, topic, {
      document: { file_id: "d", file_unique_id: "u", file_size: MAX_ATTACHMENT_BYTES + 1 },
    }, "1");
    expect(download).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
    expect(replies[0]).toContain("too large");
  });

  it("skips an oversize image with a notice and no enqueue", async () => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
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
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
        filePath: "photos/file_1.jpg",
      })),
    });
    await processTelegramMessage(deps, topic, photoMsg("caption"), "1");

    expect(replies[0]).toContain("too large");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input.text).toBe("caption");
    expect(enqueued[0].input.files).toBeUndefined();
  });

  const pdfMsg = (caption?: string, mimeType = "application/pdf") => ({
    document: { file_id: "d", file_unique_id: "ud", file_name: "report.pdf", mime_type: mimeType },
    ...(caption ? { caption } : {}),
  });
  const validPdf = new TextEncoder().encode("%PDF-1.7\nvalid enough for ingestion");

  it.each([[undefined], ["summarize this"]])("stores and enqueues a PDF with caption %s", async (caption) => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({ bytes: validPdf, filePath: "documents/report.pdf" })),
    });
    await processTelegramMessage(deps, topic, pdfMsg(caption), "1");

    expect(replies).toEqual([]);
    expect(enqueued).toHaveLength(1);
    const input = enqueued[0].input;
    expect(input.text).toBe(caption ?? "");
    expect(input.files).toEqual([{
      filename: "report.pdf",
      mimeType: "application/pdf",
      bytes: validPdf,
    }]);
  });

  it("accepts a PDF filename without a MIME type after byte validation", async () => {
    const { deps, enqueued } = makeDeps({
      download: vi.fn(async () => ({ bytes: validPdf, filePath: "documents/report.pdf" })),
    });
    await processTelegramMessage(deps, topic, pdfMsg(undefined, "application/octet-stream"), "1");
    expect(enqueued[0].input.files?.[0].mimeType).toBe("application/pdf");
  });

  it("rejects spoofed PDF content without storing or enqueueing", async () => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("not a pdf"), filePath: "documents/report.pdf" })),
    });
    await processTelegramMessage(deps, topic, pdfMsg(), "1");
    expect(enqueued).toEqual([]);
    expect(replies[0]).toContain("not a valid PDF");
  });

  it("stores an encrypted-looking PDF for later format-specific handling", async () => {
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7\n/Encrypt 4 0 R"), filePath: "documents/report.pdf" })),
    });
    await processTelegramMessage(deps, topic, pdfMsg(), "1");
    expect(replies).toEqual([]);
    expect(enqueued[0].input.files?.[0].mimeType).toBe("application/pdf");
  });

  it("rejects an oversize PDF without storing an attachment row", async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    const { deps, enqueued, replies } = makeDeps({
      download: vi.fn(async () => ({ bytes, filePath: "documents/report.pdf" })),
    });
    await processTelegramMessage(deps, topic, pdfMsg(), "1");
    expect(enqueued).toEqual([]);
    expect(replies[0]).toContain("file is too large");
  });

  it("stores a generic document with no text", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      { document: { file_id: "d", file_unique_id: "ud", mime_type: "text/plain" } },
      "1",
    );

    expect(replies).toEqual([]);
    expect(enqueued[0].input.files?.[0]).toMatchObject({
      filename: "document_ud.txt",
      mimeType: "text/plain",
    });
  });

  it("stores a generic document alongside its caption", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      {
        document: { file_id: "d", file_unique_id: "ud", mime_type: "text/plain" },
        caption: "see attached",
      },
      "1",
    );

    expect(enqueued[0].input.text).toBe("see attached");
    expect(enqueued[0].input.files).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it("stores a sticker as a generic file", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(
      deps,
      topic,
      { sticker: { file_id: "s", file_unique_id: "us" } },
      "1",
    );

    expect(replies).toEqual([]);
    expect(enqueued[0].input.files?.[0]).toMatchObject({
      filename: "sticker_us.webp",
      mimeType: "image/webp",
    });
  });

  it("notifies on file quota exhaustion and still enqueues the caption", async () => {
    const calls: EnqueueTurnInput[] = [];
    const quota = new Error("full");
    quota.name = "FileQuotaExceededError";
    const { deps, replies } = makeDeps({
      enqueue: async (_user, input) => {
        calls.push(input);
        if (input.files) throw quota;
      },
    });
    await processTelegramMessage(deps, topic, photoMsg("keep this text"), "1");
    expect(replies[0]).toContain("storage is full");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ text: "keep this text" });
    expect(calls[1].files).toBeUndefined();
  });

  it("enqueues a plain text message unchanged", async () => {
    const { deps, enqueued, replies } = makeDeps();
    await processTelegramMessage(deps, topic, { text: "hello" }, "1");

    expect(replies).toEqual([]);
    expect(enqueued[0].input.text).toBe("hello");
    expect(enqueued[0].input.files).toBeUndefined();
  });

  it("drops a message with no content and no attachment", async () => {
    const { deps, enqueued } = makeDeps();
    await processTelegramMessage(deps, topic, {}, "1");
    expect(enqueued).toEqual([]);
  });

  it("tells an unknown telegram id where to sign in and enqueues nothing", async () => {
    const { deps, enqueued, replies } = makeDeps({ getClerkUserId: async () => null });
    await processTelegramMessage(deps, topic, photoMsg(), "1");
    expect(enqueued).toEqual([]);
    expect(replies).toEqual([SIGN_IN_REPLY]);
  });
});

// Route-level: the /start command must never reach the generic message handler,
// which would send the literal text "/start" to the model as a user message.
describe("webhook routing of /start", () => {
  const post = async (body: unknown, env: Record<string, unknown>) => {
    const router = createTelegramWebhookRoute();
    const pending: Promise<unknown>[] = [];
    const res = await router.fetch(
      new Request("https://example.test/api/webhooks/telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret",
        },
        body: JSON.stringify(body),
      }),
      env,
      {
        waitUntil: (p: Promise<unknown>) => {
          pending.push(p);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );
    await Promise.all(pending);
    return res;
  };

  const startUpdate = {
    update_id: 7,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 100, type: "private" },
      from: { id: 111, is_bot: false, first_name: "A" },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  };

  it("does not enqueue the literal /start text", async () => {
    const enqueued: EnqueueTurnInput[] = [];
    const started: unknown[][] = [];
    const env = {
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_INFO: JSON.stringify({
        id: 1,
        is_bot: true,
        first_name: "Zero",
        username: "zero_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      }),
      TELEGRAM_API_ROOT: "https://api.telegram.test",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      KV: { get: async () => "user_abc" },
      USER_DO: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({
          enqueueTurn: async (input: EnqueueTurnInput) => {
            enqueued.push(input);
          },
          startConversation: async (...args: unknown[]) => {
            started.push(args);
            return true;
          },
        }),
      },
    };

    const res = await post(startUpdate, env);

    expect(res.status).toBe(200);
    expect(enqueued).toEqual([]);
    expect(started).toEqual([["user_abc", 100, 0, "start:7"]]);
  });
});
