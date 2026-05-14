/**
 * ============================================================================
 * Telegram Webhook Route
 * ============================================================================
 *
 * POST /api/webhooks/telegram — public route.
 *
 * The route delegates to grammY's `webhookCallback` ("hono" adapter), which
 * validates the X-Telegram-Bot-Api-Secret-Token header against
 * TELEGRAM_WEBHOOK_SECRET, parses the body as a Telegram `Update`, and
 * dispatches to bot middleware.
 *
 * The bot middleware schedules `processUpdate` via
 * `executionCtx.waitUntil` and returns synchronously, so Telegram gets a
 * 200 immediately. The background task looks up the originating Telegram
 * user in KV (`tg:{telegramId} → clerkUserId`) and either logs that we'll
 * process the update for that user or drops it as unknown.
 *
 * Durability note: because the KV lookup happens after the 200, a worker
 * crash inside `waitUntil` silently drops the update — Telegram won't
 * retry. Acceptable for this app today.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Bot, webhookCallback } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Env } from "../types";

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, { botInfo });

    bot.use((ctx) => {
      const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
      if (!telegramId) {
        console.log(
          "Dropping update without an originating user:",
          JSON.stringify(ctx.update),
        );
        return;
      }
      c.executionCtx.waitUntil(processUpdate(telegramId, ctx.update, c.env));
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};

/**
 * Resolve the Telegram user to a Clerk user via KV and log the routing
 * decision. Real per-user handling will be added here later.
 */
const processUpdate = async (
  telegramId: string,
  update: Update,
  env: Env,
): Promise<void> => {
  const clerkUserId = await env.KV.get(`tg:${telegramId}`);
  if (!clerkUserId) {
    console.log(`Dropping update for unknown telegramId=${telegramId}`);
    return;
  }
  console.log(
    `Processing update for clerkUserId=${clerkUserId} telegramId=${telegramId} updateId=${update.update_id}`,
  );
};
