// Clerk-authed routes for the signed-in user's settings.
//
// KV schema:
//   clerk:{clerkUserId} → telegramId   (forward, read by the web UI)
//   tg:{telegramId}     → clerkUserId  (reverse, read by the webhook)

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

const TelegramIdSchema = z.object({
  telegramId: z.string().nullable(),
});

const SetTelegramIdSchema = z.object({
  telegramId: z.string().trim().min(1).max(64).nullable(),
});

const clerkKey = (clerkUserId: string) => `clerk:${clerkUserId}`;
const tgKey = (telegramId: string) => `tg:${telegramId}`;

export const createUserSettingsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const getRoute = createRoute({
    method: "get",
    path: "/api/telegram-id",
    tags: ["UserSettings"],
    summary: "Get the caller's Telegram id",
    responses: {
      200: {
        content: { "application/json": { schema: TelegramIdSchema } },
        description: "Current Telegram id (null if unset)",
      },
    },
  });

  router.openapi(getRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const telegramId = await c.env.KV.get(clerkKey(clerkUserId));
    return c.json({ telegramId }, 200);
  });

  const putRoute = createRoute({
    method: "put",
    path: "/api/telegram-id",
    tags: ["UserSettings"],
    summary: "Set the caller's Telegram id",
    request: {
      body: {
        content: { "application/json": { schema: SetTelegramIdSchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: TelegramIdSchema } },
        description: "Updated Telegram id",
      },
    },
  });

  router.openapi(putRoute, async (c) => {
    const { telegramId } = c.req.valid("json");
    const clerkUserId = c.get("userId");
    const env = c.env;

    const previous = await env.KV.get(clerkKey(clerkUserId));

    // Clear stale reverse-index entry if the telegram id changed or was cleared.
    if (previous && previous !== telegramId) {
      await env.KV.delete(tgKey(previous));
    }

    if (telegramId) {
      await env.KV.put(clerkKey(clerkUserId), telegramId);
      await env.KV.put(tgKey(telegramId), clerkUserId);
    } else {
      await env.KV.delete(clerkKey(clerkUserId));
    }

    return c.json({ telegramId }, 200);
  });

  return router;
};
