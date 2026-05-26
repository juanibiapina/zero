// POST /api/webhooks/telegram — public route.
//
// Accepts forum topic messages only; everything else (DMs, edits,
// channel posts) is dropped. grammY's `webhookCallback` validates the
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
  type TopicMessage,
} from "../process-topic-message";
import type { Env } from "../types";

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, { botInfo });

    const sendTyping = async (chatId: number, threadId: number) => {
      await bot.api.sendChatAction(chatId, "typing", {
        message_thread_id: threadId,
      });
    };

    const sendReply = async (
      chatId: number,
      threadId: number,
      text: string,
    ) => {
      await bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId,
      });
    };

    bot.command("new", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      if (!msg.is_topic_message || msg.message_thread_id === undefined) {
        log("drop_non_topic_command", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }
      const topic: TopicContext = {
        telegramId: String(ctx.from.id),
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
      };
      c.executionCtx.waitUntil(
        processNewCommand(topic, c.env, sendReply),
      );
    });

    bot.command("abort", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      if (!msg.is_topic_message || msg.message_thread_id === undefined) {
        log("drop_non_topic_command", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }
      const topic: TopicContext = {
        telegramId: String(ctx.from.id),
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
      };
      c.executionCtx.waitUntil(
        processAbortCommand(topic, c.env, sendReply),
      );
    });

    bot.command("status", (ctx) => {
      const msg = ctx.msg;
      if (!ctx.from) return;
      if (!msg.is_topic_message || msg.message_thread_id === undefined) {
        log("drop_non_topic_command", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }
      const topic: TopicContext = {
        telegramId: String(ctx.from.id),
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
      };
      c.executionCtx.waitUntil(
        processStatusCommand(topic, c.env, sendReply),
      );
    });

    bot.on("message", (ctx) => {
      const msg = ctx.message;
      if (!msg.is_topic_message || msg.message_thread_id === undefined) {
        log("drop_non_topic_message", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }
      if (typeof msg.text !== "string" || msg.text.length === 0) {
        log("drop_topic_message_without_text", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }

      const topic: TopicMessage = {
        telegramId: String(ctx.from.id),
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
        text: msg.text,
      };
      c.executionCtx.waitUntil(
        processTopicMessage(topic, c.env, sendTyping),
      );
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};
