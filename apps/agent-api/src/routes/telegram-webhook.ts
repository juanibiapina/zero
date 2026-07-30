// POST /api/webhooks/telegram — public route.
//
// Accepts forum topic messages and direct messages (DMs). Channel
// posts and edits are dropped. DMs use topicId=0 as a convention
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
import {
  attachmentKey,
  type AttachmentStore,
} from "../attachments/types";
import { createR2Attachments } from "../attachments/r2";
import { renderAttachmentMarker } from "../attachments/marker";

const tgKey = (telegramId: string) => `tg:${telegramId}`;

// Build a TopicContext from a Telegram message. Topic messages (forum
// groups or DM topics) use message_thread_id; plain DMs use topicId=0.
// Everything else is dropped.
export const resolveContext = (
  fromId: number,
  msg: { chat: { type: string; id: number }; is_topic_message?: boolean; message_thread_id?: number },
): TopicContext | null => {
  // Topic messages: forum supergroups or DMs with topics enabled.
  if (msg.is_topic_message && msg.message_thread_id !== undefined) {
    return { telegramId: String(fromId), chatId: msg.chat.id, topicId: msg.message_thread_id };
  }
  // Plain DMs (no topics).
  if (msg.chat.type === "private") {
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
}

interface GenericFile {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
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
  sticker?: FileRef;
}

export interface AttachmentMeta {
  file_id: string;
  // Stable per-file id used in the R2 key so duplicate webhooks are idempotent.
  fileUniqueId: string;
  filename: string;
  mimeType: string;
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

// Image mime types the view_attachment path handles. Stickers are excluded by
// kind even though a static sticker is image/webp.
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const isImage = (mimeType: string): boolean =>
  IMAGE_MIME_TYPES.has(mimeType);

// Cap on downloaded attachment bytes. Anything larger is skipped with a notice
// rather than pushed through R2 and the model.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
      kind: "photo",
    };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { file_id: a.file_id, fileUniqueId: a.file_unique_id, filename: deriveName(a, "animation", "video/mp4"), mimeType: a.mime_type ?? "video/mp4", kind: "animation" };
  }
  if (msg.video) {
    const v = msg.video;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: deriveName(v, "video", "video/mp4"), mimeType: v.mime_type ?? "video/mp4", kind: "video" };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { file_id: a.file_id, fileUniqueId: a.file_unique_id, filename: deriveName(a, "audio", "audio/mpeg"), mimeType: a.mime_type ?? "audio/mpeg", kind: "audio" };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: deriveName(v, "voice", "audio/ogg"), mimeType: v.mime_type ?? "audio/ogg", kind: "voice" };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { file_id: v.file_id, fileUniqueId: v.file_unique_id, filename: `video_note_${v.file_unique_id}.mp4`, mimeType: "video/mp4", kind: "video_note" };
  }
  if (msg.document) {
    const d = msg.document;
    return { file_id: d.file_id, fileUniqueId: d.file_unique_id, filename: deriveName(d, "document", "application/octet-stream"), mimeType: d.mime_type ?? "application/octet-stream", kind: "document" };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    return { file_id: s.file_id, fileUniqueId: s.file_unique_id, filename: `sticker_${s.file_unique_id}.webp`, mimeType: "image/webp", kind: "sticker" };
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

// A persisted attachment metadata row (bytes already in R2).
interface AttachmentRow {
  id: string;
  r2Key: string;
  filename: string;
  mimeType: string;
}

// The turn payload handed to the DO. Attachment rows ride along so the DO
// persists them against the conversation it creates.
export interface EnqueueTurnInput {
  updateId: string;
  clerkUserId: string;
  chatId: number;
  topicId: number;
  text: string;
  attachments?: AttachmentRow[];
}

// Injected seams so the message pipeline is testable without grammY or a DO.
export interface WebhookDeps {
  attachments: AttachmentStore;
  download: (fileId: string) => Promise<{ bytes: Uint8Array; filePath: string }>;
  getClerkUserId: (telegramId: string) => Promise<string | null>;
  enqueue: (clerkUserId: string, input: EnqueueTurnInput) => Promise<void>;
  sendReply: (chatId: number, topicId: number, text: string) => Promise<void>;
  sendTyping: (chatId: number, topicId: number) => Promise<void>;
}

const ATTACHMENT_ONLY_NOTICE =
  "\u26a0\ufe0f I can't handle that attachment \u2014 send me a photo or text.";
const IGNORED_NOTICE =
  "\u26a0\ufe0f I ignored the attached file (not a supported type).";
const OVERSIZE_NOTICE =
  "\u26a0\ufe0f That image is too large for me to handle (over 5 MB).";

// The whole async body of a message webhook: resolve the user, download an
// image to R2 (marker into the message body), or keep today's notice-and-skip
// for non-image attachments, then enqueue the turn. Extracted from the grammY
// closure so it is unit-testable with injected deps.
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

  const isImageAttachment =
    attachment !== null &&
    attachment.kind !== "sticker" &&
    isImage(attachment.mimeType);

  // Non-image attachment: keep prior behavior. Attachment-only -> notice + skip;
  // text + attachment -> process the text and note the file was ignored.
  if (attachment && !isImageAttachment) {
    if (text.length === 0) {
      await deps
        .sendReply(topic.chatId, topic.topicId, ATTACHMENT_ONLY_NOTICE)
        .catch(() => {});
      return;
    }
    await deps.sendTyping(topic.chatId, topic.topicId).catch(() => {});
    await deps.enqueue(clerkUserId, {
      updateId,
      clerkUserId,
      chatId: topic.chatId,
      topicId: topic.topicId,
      text,
    });
    await deps
      .sendReply(topic.chatId, topic.topicId, IGNORED_NOTICE)
      .catch(() => {});
    return;
  }

  // Image: download bytes, enforce the size cap, put to R2, build the marker.
  let marker = "";
  let row: AttachmentRow | undefined;
  if (attachment && isImageAttachment) {
    try {
      const { bytes, filePath } = await deps.download(attachment.file_id);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        await deps
          .sendReply(topic.chatId, topic.topicId, OVERSIZE_NOTICE)
          .catch(() => {});
      } else {
        const filename = refineFilename(attachment.filename, filePath);
        const r2Key = attachmentKey(clerkUserId, attachment.fileUniqueId);
        await deps.attachments.put(r2Key, bytes, attachment.mimeType);
        const id = `att_${crypto.randomUUID()}`;
        marker = renderAttachmentMarker({ id, filename });
        row = { id, r2Key, filename, mimeType: attachment.mimeType };
      }
    } catch (err) {
      logError("attachment_download_failed", { error: fmtErr(err) });
      await deps
        .sendReply(topic.chatId, topic.topicId, OVERSIZE_NOTICE)
        .catch(() => {});
    }
  }

  const body = marker ? (text ? `${text}\n\n${marker}` : marker) : text;
  // No text and no usable image (oversize or failed download): the notice was
  // already sent, nothing to process.
  if (body.length === 0) return;

  await deps.sendTyping(topic.chatId, topic.topicId).catch(() => {});
  await deps.enqueue(clerkUserId, {
    updateId,
    clerkUserId,
    chatId: topic.chatId,
    topicId: topic.topicId,
    text: body,
    ...(row ? { attachments: [row] } : {}),
  });
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
      attachments: createR2Attachments(c.env.ATTACHMENTS),
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
