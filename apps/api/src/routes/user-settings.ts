// Clerk-authed routes for the signed-in user's settings.
//
// Telegram link data lives in the UserDO (one instance per Clerk user).
// The only KV entry is the reverse lookup `tg:{telegramId} → clerkUserId`,
// kept in sync so the Telegram webhook can bootstrap without knowing the
// Clerk user ID.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log, logError } from "../log";
import {
  TelegramAuthPayloadSchema,
  verifyTelegramAuth,
} from "../telegram-auth";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const TelegramIdSchema = z.object({
  telegramId: z.string().nullable(),
});

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
    const userDO = getUserDO(c.env, clerkUserId);
    const telegramId = await userDO.getTelegramId();
    return c.json({ telegramId }, 200);
  });

  const ErrorSchema = z.object({ error: z.string() });

  const linkRoute = createRoute({
    method: "post",
    path: "/api/telegram-link",
    tags: ["UserSettings"],
    summary: "Link the caller's Telegram account via Login Widget payload",
    request: {
      body: {
        content: { "application/json": { schema: TelegramAuthPayloadSchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: TelegramIdSchema } },
        description: "Account linked",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Hash mismatch or stale payload",
      },
    },
  });

  router.openapi(linkRoute, async (c) => {
    const payload = c.req.valid("json");
    const clerkUserId = c.get("userId");

    const ok = await verifyTelegramAuth(payload, c.env.TELEGRAM_BOT_TOKEN);
    if (!ok) {
      logError("telegram_link_rejected", {
        clerk_user_id: clerkUserId,
        telegram_id: String(payload.id),
      });
      return c.json({ error: "invalid telegram auth payload" }, 401);
    }

    const telegramId = String(payload.id);
    const userDO = getUserDO(c.env, clerkUserId);
    const { previous } = await userDO.linkTelegram(telegramId);

    // Sync the reverse KV lookup for the webhook
    if (previous && previous !== telegramId) {
      await c.env.KV.delete(tgKey(previous));
    }
    await c.env.KV.put(tgKey(telegramId), clerkUserId);

    log("telegram_linked", {
      clerk_user_id: clerkUserId,
      telegram_id: telegramId,
    });
    return c.json({ telegramId }, 200);
  });

  const unlinkRoute = createRoute({
    method: "delete",
    path: "/api/telegram-id",
    tags: ["UserSettings"],
    summary: "Unlink the caller's Telegram account",
    responses: {
      200: {
        content: { "application/json": { schema: TelegramIdSchema } },
        description: "Telegram id cleared",
      },
    },
  });

  router.openapi(unlinkRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const { removed } = await userDO.unlinkTelegram();

    if (removed) {
      await c.env.KV.delete(tgKey(removed));
    }

    log("telegram_unlinked", { clerk_user_id: clerkUserId });
    return c.json({ telegramId: null }, 200);
  });

  return router;
};
