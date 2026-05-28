// Clerk-authed routes for managing user S3 mount configurations.
//
// Mount config data lives in the UserDO (one instance per Clerk user).
// Only the "notes" scope is configurable today; "agent-state" always
// uses Zero-managed R2.
//
// PUT validates the bucket before saving. POST .../validate re-checks
// an already-saved config.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log, logError } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import type { S3MountConfig } from "../UserDO/index";
import {
  validateS3Bucket,
  type ValidateResult,
} from "../s3-validate";

type Variables = {
  userId: string;
};

type Validator = (config: S3MountConfig) => Promise<ValidateResult>;

const S3MountConfigInputSchema = z.object({
  endpoint: z.string().url().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

const S3MountConfigResponseSchema = z
  .object({
    endpoint: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    accessKeyId: z.string(),
  })
  .nullable();

const ErrorSchema = z.object({ error: z.string() });

const ValidateResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const redact = (config: S3MountConfig) => ({
  endpoint: config.endpoint,
  bucket: config.bucket,
  prefix: config.prefix,
  accessKeyId: config.accessKeyId,
});

export const createMountConfigRoutes = (
  validator: Validator = validateS3Bucket,
) => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // GET — read current config (redacted)
  const getRoute = createRoute({
    method: "get",
    path: "/api/mount-config/notes",
    tags: ["MountConfig"],
    summary: "Get the caller's notes mount config",
    responses: {
      200: {
        content: {
          "application/json": { schema: S3MountConfigResponseSchema },
        },
        description: "Current mount config (secret key redacted) or null",
      },
    },
  });

  router.openapi(getRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const config = await userDO.getMountConfig("notes");
    if (!config) return c.json(null, 200);
    return c.json(redact(config), 200);
  });

  // PUT — validate then save
  const putRoute = createRoute({
    method: "put",
    path: "/api/mount-config/notes",
    tags: ["MountConfig"],
    summary: "Validate and save the caller's notes mount config",
    request: {
      body: {
        content: {
          "application/json": { schema: S3MountConfigInputSchema },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: S3MountConfigResponseSchema },
        },
        description: "Config saved (secret key redacted)",
      },
      422: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Bucket validation failed",
      },
    },
  });

  router.openapi(putRoute, async (c) => {
    const payload = c.req.valid("json");
    const clerkUserId = c.get("userId");

    const result = await validator(payload);
    if (!result.ok) {
      logError("mount_config_validation_failed", {
        clerk_user_id: clerkUserId,
        scope: "notes",
        endpoint: payload.endpoint,
        bucket: payload.bucket,
        error: result.error ?? "unknown",
      });
      return c.json({ error: result.error ?? "bucket validation failed" }, 422);
    }

    const userDO = getUserDO(c.env, clerkUserId);
    await userDO.setMountConfig("notes", payload);
    log("mount_config_saved", {
      clerk_user_id: clerkUserId,
      scope: "notes",
      endpoint: payload.endpoint,
      bucket: payload.bucket,
    });
    return c.json(redact(payload), 200);
  });

  // POST validate — re-check an already-saved config
  const validateRoute = createRoute({
    method: "post",
    path: "/api/mount-config/notes/validate",
    tags: ["MountConfig"],
    summary: "Validate the caller's saved notes mount config",
    responses: {
      200: {
        content: {
          "application/json": { schema: ValidateResponseSchema },
        },
        description: "Validation result",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "No config saved for this scope",
      },
    },
  });

  router.openapi(validateRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const config = await userDO.getMountConfig("notes");
    if (!config) {
      return c.json({ error: "no config saved" }, 404);
    }
    const result = await validator(config);
    return c.json(result, 200);
  });

  // DELETE — remove config
  const deleteRoute = createRoute({
    method: "delete",
    path: "/api/mount-config/notes",
    tags: ["MountConfig"],
    summary: "Remove the caller's notes mount config (revert to default R2)",
    responses: {
      200: {
        content: {
          "application/json": { schema: S3MountConfigResponseSchema },
        },
        description: "Config removed",
      },
    },
  });

  router.openapi(deleteRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    await userDO.deleteMountConfig("notes");
    log("mount_config_deleted", {
      clerk_user_id: clerkUserId,
      scope: "notes",
    });
    return c.json(null, 200);
  });

  return router;
};
