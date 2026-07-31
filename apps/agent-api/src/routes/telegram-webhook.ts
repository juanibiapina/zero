// POST /api/webhooks/telegram — public route.
//
// Accepts forum topic messages, direct messages (DMs) and ordinary
// group messages (including a forum's General tab). Channel posts and
// edits are dropped. Chats without a topic use topicId=0 as a convention
// so the rest of the pipeline (UserDO session mapping, reply path)
// works unchanged. grammY's `webhookCallback` validates the
// X-Telegram-Bot-Api-Secret-Token header. The bot middleware schedules
// `processTopicMessage` via `executionCtx.waitUntil` and the route
// returns 200 immediately. Background failures are logged and dropped.
//
// Self-heal: if `sendMessage` returns `stale` (the container lost its
// in-memory session map), we drop the stale KV entries and create a
// fresh session once. User sees a new conversation start; no notice.
//
// See docs/design.md § Routes for the full pipeline.

import { OpenAPIHono } from "@hono/zod-openapi";
import { webhookCallback } from "grammy";
import { createBot } from "../telegram/bot";
import { log, logError, fmtErr } from "../log";
import { processNewCommand } from "../commands/new";
import type { TopicContext } from "../telegram/context";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";
import { sendChatAction } from "../telegram/chat-action";
import { formatAndSend } from "../telegram/send";
import { downloadTelegramFile } from "../telegram/files";
import { MAX_FILE_BYTES } from "../files/types";

const tgKey = (telegramId: string) => `tg:${telegramId}`;

// Build a TopicContext from a Telegram message. Topic messages (forum
// groups or DM topics) use message_thread_id; every other private, group
// or supergroup chat uses topicId=0. Channel posts are dropped.
//
// The is_topic_message guard matters: Telegram attaches a message_thread_id
// to replies in non-forum groups and to replies in a forum's General tab,
// and that id is not a usable topic (sending to it fails with
// "message thread not found"). Those messages belong to topicId=0.
export const resolveContext = (
  fromId: number,
  msg: { chat: { type: string; id: number }; is_topic_message?: boolean; message_thread_id?: number },
): TopicContext | null => {
  // Topic messages: forum supergroups or DMs with topics enabled.
  if (msg.is_topic_message && msg.message_thread_id !== undefined) {
    return { telegramId: String(fromId), chatId: msg.chat.id, topicId: msg.message_thread_id };
  }
  // Everything else with a conversation: plain DMs, groups, and a forum's
  // General tab (Telegram marks none of these as topic messages).
  if (msg.chat.type === "private" || msg.chat.type === "group" || msg.chat.type === "supergroup") {
    return { telegramId: String(fromId), chatId: msg.chat.id, topicId: 0 };
  }
  log("drop_unsupported_message", { telegram_id: String(fromId), chat_type: msg.chat.type });
  return null;
};

// Telegram's PhotoSize. The Bot API guarantees `Message.photo` is an array of
// the available sizes, each with width and height and an optional file size. It
// does NOT document the array's order or promise fixed dimensions, so both are
// measured rather than assumed (see the telegram_photo_variants log below).
// https://core.telegram.org/bots/api#photosize
interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
// The two fields every downloadable Telegram file carries.
interface FileRef {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

interface GenericFile extends FileRef {
  file_name?: string;
  mime_type?: string;
}

interface StickerFile extends FileRef {
  is_animated?: boolean;
  is_video?: boolean;
}

// The subset of a Telegram message that may carry a downloadable file.
export interface AttachmentMessage {
  photo?: PhotoSize[];
  animation?: GenericFile;
  video?: GenericFile;
  audio?: GenericFile;
  voice?: GenericFile;
  video_note?: FileRef;
  document?: GenericFile;
  sticker?: StickerFile;
}

export interface AttachmentMeta {
  file_id: string;
  // Stable per-file id used in the R2 key so duplicate webhooks are idempotent.
  fileUniqueId: string;
  filename: string;
  mimeType: string;
  declaredSize?: number;
  // Which Telegram field the file came from. Used to keep stickers (which carry
  // an image/webp mimeType) out of the image path.
  kind:
    | "photo"
    | "animation"
    | "video"
    | "audio"
    | "voice"
    | "video_note"
    | "document"
    | "sticker";
}

// Image MIME types view_image can return as native Anthropic image blocks.
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const isImage = (mimeType: string): boolean =>
  IMAGE_MIME_TYPES.has(mimeType);

const isPdfAttachment = (attachment: AttachmentMeta): boolean =>
  attachment.kind === "document" &&
  (attachment.mimeType === "application/pdf" || attachment.filename.toLowerCase().endsWith(".pdf"));

const bytesContain = (bytes: Uint8Array, needle: string, limit = bytes.length): boolean => {
  const encoded = new TextEncoder().encode(needle);
  const end = Math.min(bytes.length, limit) - encoded.length;
  outer: for (let i = 0; i <= end; i += 1) {
    for (let j = 0; j < encoded.length; j += 1) {
      if (bytes[i + j] !== encoded[j]) continue outer;
    }
    return true;
  }
  return false;
};

export const hasPdfSignature = (bytes: Uint8Array): boolean =>
  bytesContain(bytes, "%PDF-", 1024);

// Cap on downloaded attachment bytes. Anything larger is skipped with a notice
// rather than pushed through R2 and the model.
export const MAX_ATTACHMENT_BYTES = MAX_FILE_BYTES;

// Strip an untrusted filename to a safe basename: no path separators,
// no parent-dir traversal.
const sanitizeFilename = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/\.\.+/g, ".").trim();
  return cleaned.length > 0 ? cleaned : "file";
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "text/plain": "txt",
};

// Prefer the client-supplied file_name; otherwise synthesize
// <prefix>_<unique_id> with an extension derived from the MIME type.
const deriveName = (f: GenericFile, prefix: string, defaultMime: string): string => {
  if (f.file_name) return sanitizeFilename(f.file_name);
  const ext = EXT_BY_MIME[f.mime_type ?? defaultMime];
  return ext ? `${prefix}_${f.file_unique_id}.${ext}` : `${prefix}_${f.file_unique_id}`;
};

// Resolve the single downloadable attachment from a message, in priority
// order. Several fields are double-set for backward compat (animation also
// sets document, live_photo also sets photo), so order matters: check the
// more specific field first.
export const extractAttachment = (msg: AttachmentMessage): AttachmentMeta | null => {
  if (msg.photo && msg.photo.length > 0) {
    // Selection is unchanged (the last candidate) while the shape of real
    // payloads is being sampled. The log carries only dimensions and sizes,
    // never file ids, and records which candidate the current rule picked, so
    // a cost-based rule can be derived from production data instead of folklore.
    log("telegram_photo_variants", {
      candidate_count: msg.photo.length,
      widths: msg.photo.map((p) => p.width),
      heights: msg.photo.map((p) => p.height),
      file_sizes: msg.photo.map((p) => p.file_size ?? null),
      selected_index: msg.photo.length - 1,
    });
    const largest = msg.photo[msg.photo.length - 1];
    return {
      file_id: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      filename: `photo_${largest.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      declaredSize: largest.file_size,
      kind: "photo",
    };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { file_id: a.file_id, fileUniqueId: a.file_unique_id, filename: deriveName(a, "animation", "video/mp4"), mimeType: a.mime_type ?? "video/mp4", declaredSize: a.file_size, kind: "animation" };
  }
  if (msg.video) {
    const v = msg.video;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: deriveName(v, "video", "video/mp4"), mimeType: v.mime_type ?? "video/mp4", declaredSize: v.file_size, kind: "video" };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { file_id: a.file_id, fileUniqueId: a.file_unique_id, filename: deriveName(a, "audio", "audio/mpeg"), mimeType: a.mime_type ?? "audio/mpeg", declaredSize: a.file_size, kind: "audio" };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: deriveName(v, "voice", "audio/ogg"), mimeType: v.mime_type ?? "audio/ogg", declaredSize: v.file_size, kind: "voice" };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: `video_note_${v.file_unique_id}.mp4`, mimeType: "video/mp4", declaredSize: v.file_size, kind: "video_note" };
  }
  if (msg.document) {
    const d = msg.document;
    return { file_id: d.file_id, fileUniqueId: d.file_unique_id, filename: deriveName(d, "document", "application/octet-stream"), mimeType: d.mime_type ?? "application/octet-stream", declaredSize: d.file_size, kind: "document" };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    const format = s.is_animated
      ? { extension: "tgs", mimeType: "application/x-tgsticker" }
      : s.is_video
        ? { extension: "webm", mimeType: "video/webm" }
        : { extension: "webp", mimeType: "image/webp" };
    return {
      file_id: s.file_id,
      fileUniqueId: s.file_unique_id,
      filename: `sticker_${s.file_unique_id}.${format.extension}`,
      mimeType: format.mimeType,
      declaredSize: s.file_size,
      kind: "sticker",
    };
  }
  return null;
};

// When we synthesized a name without an extension, borrow the real one
// from getFile's file_path (which usually carries a true extension).
export const refineFilename = (filename: string, filePath: string): string => {
  if (/\.[A-Za-z0-9]+$/.test(filename)) return filename;
  const m = filePath.match(/\.([A-Za-z0-9]+)$/);
  return m ? `${filename}.${m[1]}` : filename;
};

export interface EnqueueTurnInput {
  updateId: string;
  clerkUserId: string;
  chatId: number;
  topicId: number;
  text: string;
  files?: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
}

// Injected seams so the message pipeline is testable without grammY or a DO.
export interface WebhookDeps {
  download: (fileId: string) => Promise<{ bytes: Uint8Array; filePath: string }>;
  getClerkUserId: (telegramId: string) => Promise<string | null>;
  enqueue: (clerkUserId: string, input: EnqueueTurnInput) => Promise<void>;
  sendReply: (chatId: number, topicId: number, text: string) => Promise<void>;
  sendTyping: (chatId: number, topicId: number) => Promise<void>;
}

const OVERSIZE_NOTICE = "\u26a0\ufe0f That file is too large to save (over 5 MB).";
const INVALID_PDF_NOTICE = "\u26a0\ufe0f That file is not a valid PDF, so I couldn't save it as one.";
const DOWNLOAD_FAILED_NOTICE = "\u26a0\ufe0f I couldn't download that file, so it wasn't saved.";
const QUOTA_NOTICE = "\u26a0\ufe0f I couldn't save that file because your 100 MB file storage is full.";

// Resolve and download at the Telegram edge, then hand canonical metadata and
// bytes to UserDO. UserDO owns persistence and marker construction.
export const processTelegramMessage = async (
  deps: WebhookDeps,
  topic: TopicContext,
  msg: AttachmentMessage & { text?: string; caption?: string },
  updateId: string,
): Promise<void> => {
  const text = typeof msg.text === "string" ? msg.text : (msg.caption ?? "");
  const attachment = extractAttachment(msg);
  if (text.length === 0 && !attachment) return;

  const clerkUserId = await deps.getClerkUserId(topic.telegramId);
  if (!clerkUserId) {
    log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
    return;
  }

  let incoming: { filename: string; mimeType: string; bytes: Uint8Array } | undefined;
  if (attachment) {
    const isPdf = isPdfAttachment(attachment);
    if ((attachment.declaredSize ?? 0) > MAX_FILE_BYTES) {
      await deps.sendReply(topic.chatId, topic.topicId, OVERSIZE_NOTICE).catch(() => {});
    } else {
      try {
        const { bytes, filePath } = await deps.download(attachment.file_id);
        if (bytes.length > MAX_FILE_BYTES) {
          await deps.sendReply(topic.chatId, topic.topicId, OVERSIZE_NOTICE).catch(() => {});
        } else if (isPdf && !hasPdfSignature(bytes)) {
          await deps.sendReply(topic.chatId, topic.topicId, INVALID_PDF_NOTICE).catch(() => {});
        } else {
          incoming = {
            filename: refineFilename(attachment.filename, filePath),
            mimeType: isPdf ? "application/pdf" : attachment.mimeType,
            bytes,
          };
        }
      } catch (error) {
        logError("file_download_failed", { reason: "provider_rejection", error: fmtErr(error) });
        await deps.sendReply(topic.chatId, topic.topicId, DOWNLOAD_FAILED_NOTICE).catch(() => {});
      }
    }
  }

  if (!text && !incoming) return;
  await deps.sendTyping(topic.chatId, topic.topicId).catch(() => {});
  try {
    await deps.enqueue(clerkUserId, {
      updateId,
      clerkUserId,
      chatId: topic.chatId,
      topicId: topic.topicId,
      text,
      ...(incoming ? { files: [incoming] } : {}),
    });
  } catch (error) {
    if (!incoming || !(error instanceof Error) || error.name !== "FileQuotaExceededError") {
      throw error;
    }
    logError("file_save_failed", { reason: "quota", error: fmtErr(error) });
    await deps.sendReply(topic.chatId, topic.topicId, QUOTA_NOTICE).catch(() => {});
    if (text) {
      await deps.enqueue(clerkUserId, {
        updateId,
        clerkUserId,
        chatId: topic.chatId,
        topicId: topic.topicId,
        text,
      });
    }
  }
};

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const bot = createBot(c.env);

    const sendReply = async (
      chatId: number,
      threadId: number,
      text: string,
    ) => {
      await formatAndSend(text, (formatted, parseMode) =>
        bot.api.sendMessage(chatId, formatted, {
          ...(threadId && { message_thread_id: threadId }),
          ...(parseMode && { parse_mode: parseMode }),
        }),
      );
    };

    bot.command("new", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;
      c.executionCtx.waitUntil(
        processNewCommand(topic, c.env, sendReply),
      );
    });

    const deps: WebhookDeps = {
      download: (fileId) => downloadTelegramFile(c.env, fileId),
      getClerkUserId: (telegramId) => c.env.KV.get(tgKey(telegramId)),
      enqueue: (clerkUserId, input) =>
        getUserDO(c.env, clerkUserId).enqueueTurn(input),
      sendReply,
      sendTyping: (chatId, topicId) => sendChatAction(c.env, chatId, topicId),
    };

    bot.on("message", (ctx) => {
      const msg = ctx.message;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;

      const updateId = String(ctx.update.update_id);
      c.executionCtx.waitUntil(
        processTelegramMessage(deps, topic, msg, updateId),
      );
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};
