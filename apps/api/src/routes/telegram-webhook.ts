/**
 * ============================================================================
 * Telegram Webhook Route
 * ============================================================================
 *
 * POST /api/webhooks/telegram — public route, authenticated via the
 * X-Telegram-Bot-Api-Secret-Token header.
 *
 * Looks up the originating Telegram user in KV (`tg:{telegramId} → clerkUserId`)
 * and logs the update.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";

// ── Schemas ──────────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() });
const WebhookOkSchema = z.object({ ok: z.boolean() });

// ── Helpers ──────────────────────────────────────────────────────────────

const tgKey = (telegramId: string) => `tg:${telegramId}`;

function extractTelegramUserId(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;

  // Places `from.id` can appear in a Telegram Update.
  const candidates = [
    u.message,
    u.edited_message,
    u.channel_post,
    u.edited_channel_post,
    u.callback_query,
    u.inline_query,
    u.chosen_inline_result,
    u.shipping_query,
    u.pre_checkout_query,
    u.poll_answer,
    u.my_chat_member,
    u.chat_member,
    u.chat_join_request,
  ];

  for (const c of candidates) {
    if (c && typeof c === "object") {
      const from = (c as Record<string, unknown>).from;
      if (from && typeof from === "object") {
        const id = (from as Record<string, unknown>).id;
        if (typeof id === "number") return String(id);
        if (typeof id === "string") return id;
      }
    }
  }
  return null;
}

// ── Router ───────────────────────────────────────────────────────────────

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  const webhookRoute = createRoute({
    method: "post",
    path: "/api/webhooks/telegram",
    tags: ["Webhooks"],
    summary: "Telegram bot webhook",
    description:
      "Receives Telegram bot updates. Authenticated via the X-Telegram-Bot-Api-Secret-Token header.",
    responses: {
      200: {
        content: { "application/json": { schema: WebhookOkSchema } },
        description: "Update accepted",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid secret token",
      },
    },
  });

  router.openapi(webhookRoute, async (c) => {
    const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
    const provided = c.req.header("x-telegram-bot-api-secret-token");
    if (!expected || provided !== expected) {
      return c.json({ error: "Unauthorized" }, 401 as const);
    }

    const update = (await c.req.json()) as unknown;
    const telegramId = extractTelegramUserId(update);

    if (!telegramId) {
      console.log("Telegram webhook: no user id in update", JSON.stringify(update));
      return c.json({ ok: true }, 200);
    }

    const clerkUserId = await c.env.KV.get(tgKey(telegramId));
    if (!clerkUserId) {
      console.log(`Telegram webhook: no user mapped for telegramId=${telegramId}`);
      return c.json({ ok: true }, 200);
    }

    console.log(
      `Telegram update for clerkUserId=${clerkUserId} telegramId=${telegramId}:`,
      JSON.stringify(update),
    );

    return c.json({ ok: true }, 200);
  });

  return router;
};
