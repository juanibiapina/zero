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
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { log } from "../log";
import { processNewCommand } from "../commands/new";
import type { TopicContext } from "../telegram/context";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";
import { sendChatAction } from "../telegram/chat-action";
import { formatAndSend } from "../telegram/send";

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

interface PhotoSize {
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
  video_note?: PhotoSize;
  document?: GenericFile;
  sticker?: PhotoSize;
}

export interface AttachmentMeta {
  file_id: string;
  filename: string;
  mimeType: string;
}

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
    const largest = msg.photo[msg.photo.length - 1];
    return {
      file_id: largest.file_id,
      filename: `photo_${largest.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
    };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { file_id: a.file_id, filename: deriveName(a, "animation", "video/mp4"), mimeType: a.mime_type ?? "video/mp4" };
  }
  if (msg.video) {
    const v = msg.video;
    return { file_id: v.file_id, filename: deriveName(v, "video", "video/mp4"), mimeType: v.mime_type ?? "video/mp4" };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { file_id: a.file_id, filename: deriveName(a, "audio", "audio/mpeg"), mimeType: a.mime_type ?? "audio/mpeg" };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { file_id: v.file_id, filename: deriveName(v, "voice", "audio/ogg"), mimeType: v.mime_type ?? "audio/ogg" };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { file_id: v.file_id, filename: `video_note_${v.file_unique_id}.mp4`, mimeType: "video/mp4" };
  }
  if (msg.document) {
    const d = msg.document;
    return { file_id: d.file_id, filename: deriveName(d, "document", "application/octet-stream"), mimeType: d.mime_type ?? "application/octet-stream" };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    return { file_id: s.file_id, filename: `sticker_${s.file_unique_id}.webp`, mimeType: "image/webp" };
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

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, {
      botInfo,
      client: { apiRoot: c.env.TELEGRAM_API_ROOT },
    });

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

    bot.on("message", (ctx) => {
      const msg = ctx.message;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;

      const text =
        typeof msg.text === "string" ? msg.text : (msg.caption ?? "");
      const attachment = extractAttachment(msg);

      if (text.length === 0 && !attachment) {
        log("drop_message_without_content", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }

      const updateId = String(ctx.update.update_id);

      c.executionCtx.waitUntil(
        (async () => {
          const clerkUserId = await c.env.KV.get(tgKey(topic.telegramId));
          if (!clerkUserId) {
            log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
            return;
          }

          // Attachments are out of scope for the topic model MVP. If the
          // message is attachment-only, notify and skip; if it also has text,
          // process the text and note the attachment was ignored.
          if (attachment && text.length === 0) {
            await sendReply(
              topic.chatId,
              topic.topicId,
              "⚠️ I can't handle attachments yet — send me a text message.",
            ).catch(() => {});
            return;
          }

          await sendChatAction(c.env, topic.chatId, topic.topicId).catch(
            () => {},
          );
          await getUserDO(c.env, clerkUserId).enqueueTurn({
            updateId,
            clerkUserId,
            chatId: topic.chatId,
            topicId: topic.topicId,
            text,
          });

          if (attachment) {
            await sendReply(
              topic.chatId,
              topic.topicId,
              "⚠️ I ignored the attached file (not supported yet).",
            ).catch(() => {});
          }
        })(),
      );
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};
