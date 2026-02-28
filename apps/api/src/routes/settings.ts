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
    hotkeyBindings: z.record(z.string(), z.string()),
    defaultProvider: z.string().nullable(),
    defaultModel: z.string().nullable(),
    defaultThinkingLevel: z.string().nullable(),
  }),
});

const UpdateSettingsBodySchema = z.object({
  hotkeyPrefix: z.string().optional(),
  hotkeyBindings: z.record(z.string(), z.string().nullable()).optional(),
  defaultProvider: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultThinkingLevel: z.string().nullable().optional(),
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

    // Update hotkey prefix
    if (body.hotkeyPrefix !== undefined) {
      const result = await service.updateHotkeyPrefix(body.hotkeyPrefix);
      if (Result.isFailure(result)) {
        return c.json({ error: result.error.message }, 400);
      }
    }

    // Update individual hotkey bindings
    if (body.hotkeyBindings) {
      for (const [actionId, key] of Object.entries(body.hotkeyBindings)) {
        const result = await service.updateHotkeyBinding(actionId, key);
        if (Result.isFailure(result)) {
          return c.json({ error: result.error.message }, 400);
        }
      }
    }

    // Update session defaults
    if (body.defaultProvider !== undefined) {
      const result = await service.updateDefaultProvider(body.defaultProvider);
      if (Result.isFailure(result)) {
        return c.json({ error: result.error.message }, 400);
      }
    }

    if (body.defaultModel !== undefined) {
      const result = await service.updateDefaultModel(body.defaultModel);
      if (Result.isFailure(result)) {
        return c.json({ error: result.error.message }, 400);
      }
    }

    if (body.defaultThinkingLevel !== undefined) {
      const result = await service.updateDefaultThinkingLevel(body.defaultThinkingLevel as import("@zero/core").ThinkingLevel | null);
      if (Result.isFailure(result)) {
        return c.json({ error: result.error.message }, 400);
      }
    }

    return c.json({ success: true }, 200);
  });

  return router;
};
