/**
 * ============================================================================
 * Ingest Route (POST /v1/errors)
 * ============================================================================
 *
 * API-key authed (org resolved by app middleware). Validates the payload,
 * hands it to ErrorsService, and returns 202 immediately. Notification (if any)
 * runs via waitUntil and never blocks or fails the response.
 */

import { Hono } from "hono";
import { errorReportSchema } from "@zero/errors-core";
import type { Env } from "../types";
import type { Notifier } from "../notify/notifier";
import { ErrorsService } from "../services/ErrorsService";
import { getErrorsDO } from "../vaults";

type Variables = { userId: string; orgId: string };

export const createErrorsRouter = (notifier: Notifier) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.post("/errors/v1/errors", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = errorReportSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid error report" }, 400);
    }

    const service = new ErrorsService(getErrorsDO(c), notifier);
    const result = await service.report(parsed.data, c.get("userId"), (p) =>
      c.executionCtx.waitUntil(p),
    );

    return c.json(result, 202);
  });

  return app;
};
