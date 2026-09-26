// Clerk-authed routes for the signed-in user's settings.
//
// Telegram link data lives in the UserDO (one instance per Clerk user). The
// reverse direction (Telegram account → Clerk user) is owned by
// telegram/identity.ts, which keeps the authoritative TelegramAccountDO and
// the KV cache in sync so the Telegram webhook can bootstrap without knowing
// the Clerk user ID.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log, logError } from "../log";
import {
  TelegramAuthPayloadSchema,
  verifyTelegramAuth,
} from "../telegram-auth";
import {
  linkTelegramAccount,
  unlinkTelegramAccount,
} from "../telegram/identity";
import { isValidCountry, resolveCountry } from "../country";
import { purgeUserData } from "../do/purge";
import { getLearningDO } from "../LearningDO/stub";
import { getScheduleDO } from "../ScheduleDO/stub";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import { getTaskDO } from "../TaskDO/stub";
import { isValidTimezone } from "../timezone";

type Variables = {
  userId: string;
};

const TelegramIdSchema = z.object({
  telegramId: z.string().nullable(),
});


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

    // Claim the account (authoritative) and refresh the webhook's cache.
    await linkTelegramAccount(c.env, telegramId, clerkUserId, previous);

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
      await unlinkTelegramAccount(c.env, removed);
    }

    log("telegram_unlinked", { clerk_user_id: clerkUserId });
    return c.json({ telegramId: null }, 200);
  });

  const deleteDataRoute = createRoute({
    method: "delete",
    path: "/api/user-data",
    tags: ["UserSettings"],
    summary: "Erase everything Zero stores about the caller",
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ deleted: z.boolean() }) },
        },
        description: "Data erased",
      },
    },
  });

  // Inline, never on waitUntil: the UI signs the user out on a 200, so a 200
  // has to mean the data is already gone. A failure surfaces as a 500 and the
  // user presses the button again — every step of the purge is idempotent.
  router.openapi(deleteDataRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const telegramId = await userDO.getTelegramId();
    await purgeUserData({
      telegramId,
      releaseTelegram: (id) => unlinkTelegramAccount(c.env, id),
      purgeSchedules: () => getScheduleDO(c.env, clerkUserId).purge(),
      purgeLearning: () => getLearningDO(c.env, clerkUserId).purge(),
      purgeUser: () => userDO.deleteAllData(clerkUserId),
      purgeTasks: () => getTaskDO(c.env, clerkUserId).purge(),
      resetTasks: () => getTaskDO(c.env, clerkUserId).reset(),
      resetUser: () => userDO.reset(),
    });

    log("user_data_deleted", { clerk_user_id: clerkUserId });
    return c.json({ deleted: true }, 200);
  });

  const UserSettingsSchema = z.object({
    onboardingSeen: z.boolean(),
    googleOnboardingStatus: z.string().nullable(),
    createdAt: z.string().nullable(),
    timezone: z.string().nullable(),
    country: z.string().nullable(),
  });

  const toResponse = (s: { onboardingSeen: boolean; googleOnboardingStatus: string | null; createdAt: string | null; timezone: string | null; country: string | null }) => ({
    onboardingSeen: s.onboardingSeen,
    googleOnboardingStatus: s.googleOnboardingStatus,
    createdAt: s.createdAt,
    timezone: s.timezone,
    country: s.country,
  });

  const getSettingsRoute = createRoute({
    method: "get",
    path: "/api/user-settings",
    tags: ["UserSettings"],
    summary: "Get all user settings",
    responses: {
      200: {
        content: { "application/json": { schema: UserSettingsSchema } },
        description: "Current user settings",
      },
    },
  });

  router.openapi(getSettingsRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    let settings = await userDO.getSettings();
    if (settings.isNewUser) {
      c.env.ANALYTICS.writeDataPoint({ blobs: ["signup"], indexes: [clerkUserId] });
    }
    const cfCountry = c.req.raw.cf?.country;
    const country = resolveCountry(
      typeof cfCountry === "string" ? cfCountry : undefined,
    );
    if (country !== null && country !== settings.country) {
      await userDO.updateSettings({ country });
      settings = await userDO.getSettings();
    }
    return c.json(toResponse(settings), 200);
  });

  const PatchSettingsSchema = z.object({
    onboardingSeen: z.boolean().optional(),
    timezone: z.string().optional(),
    region: z.string().optional(),
  });

  const patchSettingsRoute = createRoute({
    method: "patch",
    path: "/api/user-settings",
    tags: ["UserSettings"],
    summary: "Update user settings (partial)",
    request: {
      body: {
        content: { "application/json": { schema: PatchSettingsSchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: UserSettingsSchema } },
        description: "Updated user settings",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Invalid patch (e.g. non-IANA timezone)",
      },
    },
  });

  router.openapi(patchSettingsRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const before = await userDO.getSettings();
    const patch = c.req.valid("json");
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      return c.json({ error: "invalid timezone" }, 400);
    }
    if (
      patch.region !== undefined &&
      !isValidCountry(patch.region.toUpperCase())
    ) {
      return c.json({ error: "invalid region" }, 400);
    }
    const cfCountry = c.req.raw.cf?.country;
    const country = resolveCountry(
      typeof cfCountry === "string" ? cfCountry : undefined,
      patch.region,
    );
    await userDO.updateSettings({
      ...(patch.onboardingSeen !== undefined
        ? { onboardingSeen: patch.onboardingSeen }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(country !== null ? { country } : {}),
    });
    const after = await userDO.getSettings();
    if (patch.onboardingSeen === true && !before.onboardingSeen) {
      c.env.ANALYTICS.writeDataPoint({
        blobs: ["onboarding_completed"],
        doubles: [new Date(after.createdAt ?? "").getTime()],
        indexes: [clerkUserId],
      });
    }
    log("user_settings_updated", {
      clerk_user_id: clerkUserId,
      patch: {
        ...(patch.onboardingSeen !== undefined
          ? { onboardingSeen: patch.onboardingSeen }
          : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(country !== null ? { country } : {}),
      },
    });
    return c.json(toResponse(after), 200);
  });

  return router;
};
