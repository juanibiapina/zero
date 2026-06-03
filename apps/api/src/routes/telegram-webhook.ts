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
import { processAbortCommand } from "../commands/abort";
import { processNewCommand } from "../commands/new";
import { processStatusCommand } from "../commands/status";
import {
  processTopicMessage,
  type TopicContext,
} from "../process-topic-message";
import type { Env } from "../types";
import { sendChatAction } from "../telegram/chat-action";
import { formatAndSend } from "../telegram/send";

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

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, { botInfo });

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

    bot.command("abort", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;
      c.executionCtx.waitUntil(
        processAbortCommand(topic, c.env, sendReply),
      );
    });

    bot.command("status", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;
      c.executionCtx.waitUntil(
        processStatusCommand(topic, c.env, sendReply),
      );
    });

    bot.on("message", (ctx) => {
      const msg = ctx.message;
      const topic = resolveContext(ctx.from.id, msg);
      if (!topic) return;
      if (typeof msg.text !== "string" || msg.text.length === 0) {
        log("drop_message_without_text", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }

      c.executionCtx.waitUntil(
        sendChatAction(c.env, topic.chatId, topic.topicId).catch(() => {}),
      );
      c.executionCtx.waitUntil(
        processTopicMessage({ ...topic, text: msg.text }, c.env),
      );
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};
