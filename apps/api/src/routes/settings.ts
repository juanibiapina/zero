/**
 * ============================================================================
 * Settings Routes
 * ============================================================================
 *
 * GET   /api/settings          — Get all user settings (merged with defaults)
 * PATCH /api/settings          — Update one or more settings
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import { SettingsService } from "../services/settings";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const SettingsResponseSchema = z.object({
  settings: z.object({
    hotkeyPrefix: z.string(),
  }),
});

const UpdateSettingsBodySchema = z.object({
  hotkeyPrefix: z.string().optional(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
});

// ── Router ───────────────────────────────────────────────────────────────

export const createSettingsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── Get settings ──────────────────────────────────────────────────────

  const getSettingsRoute = createRoute({
    method: "get",
    path: "/api/settings",
    tags: ["Settings"],
    summary: "Get user settings",
    description: "Returns all user settings merged with defaults.",
    responses: {
      200: {
        content: { "application/json": { schema: SettingsResponseSchema } },
        description: "User settings",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Internal error",
      },
    },
  });

  router.openapi(getSettingsRoute, async (c) => {
    const service = new SettingsService(c.env, c.get("userId"));
    return c.json(await service.getSettings(), 200);
  });

  // ── Update settings ───────────────────────────────────────────────────

  const updateSettingsRoute = createRoute({
    method: "patch",
    path: "/api/settings",
    tags: ["Settings"],
    summary: "Update user settings",
    description: "Updates one or more user settings.",
    request: {
      body: {
        content: { "application/json": { schema: UpdateSettingsBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Settings updated",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Invalid setting",
      },
    },
  });

  router.openapi(updateSettingsRoute, async (c) => {
    const body = c.req.valid("json");
    const service = new SettingsService(c.env, c.get("userId"));

    // Update each provided setting
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) {
        const result = await service.updateSetting(key, value);
        if (Result.isFailure(result)) {
          return c.json({ error: result.error.message }, 400);
        }
      }
    }

    return c.json({ success: true }, 200);
  });

  return router;
};
