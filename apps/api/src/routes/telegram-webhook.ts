/**
 * ============================================================================
 * Telegram Webhook Route
 * ============================================================================
 *
 * POST /api/webhooks/telegram — public route.
 *
 * The route delegates to grammY's `webhookCallback` ("hono" adapter), which:
 *  - validates the X-Telegram-Bot-Api-Secret-Token header against
 *    TELEGRAM_WEBHOOK_SECRET,
 *  - parses the body as a Telegram `Update`, and
 *  - dispatches to bot middleware.
 *
 * A single middleware looks up the originating Telegram user in KV
 * (`tg:{telegramId} → clerkUserId`) and logs the update.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "../types";

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, { botInfo });

    bot.use(async (ctx) => {
      const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
      const clerkUserId = telegramId
        ? await c.env.KV.get(`tg:${telegramId}`)
        : null;

      console.log(
        `Telegram update clerkUserId=${clerkUserId ?? "<none>"} telegramId=${telegramId ?? "<none>"}:`,
        JSON.stringify(ctx.update),
      );
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};
