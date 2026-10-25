// Clerk-authed routes for the signed-in user's settings and for erasing the
// user's data.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log } from "../log";
import { purgeUserData } from "../do/purge";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import type { UserSettings } from "../UserDO/index";
import { getTaskDO } from "../TaskDO/stub";
import { isValidTimezone } from "../timezone";

type Variables = {
  userId: string;
};

const ErrorSchema = z.object({ error: z.string() });

const UserSettingsSchema = z.object({
  createdAt: z.string().nullable(),
  timezone: z.string().nullable(),
});

const toResponse = (s: UserSettings) => ({
  createdAt: s.createdAt,
  timezone: s.timezone,
});

export const createUserSettingsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

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
    const taskDO = getTaskDO(c.env, clerkUserId);
    await purgeUserData({
      purgeTasks: () => taskDO.purge(),
      purgeUser: () => userDO.deleteAllData(),
      resetTasks: () => taskDO.reset(),
      resetUser: () => userDO.reset(),
    });

    log("user_data_deleted", { clerk_user_id: clerkUserId });
    return c.json({ deleted: true }, 200);
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
    const settings = await getUserDO(c.env, clerkUserId).getSettings();
    if (settings.isNewUser) {
      c.env.ANALYTICS.writeDataPoint({ blobs: ["signup"], indexes: [clerkUserId] });
    }
    return c.json(toResponse(settings), 200);
  });

  const PatchSettingsSchema = z.object({
    timezone: z.string().optional(),
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
    const patch = c.req.valid("json");
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      return c.json({ error: "invalid timezone" }, 400);
    }
    await userDO.updateSettings(patch);
    log("user_settings_updated", { clerk_user_id: clerkUserId, patch });
    return c.json(toResponse(await userDO.getSettings()), 200);
  });

  return router;
};
