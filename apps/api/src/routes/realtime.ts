/**
 * ============================================================================
 * Realtime Route — User-level WebSocket for push events
 * ============================================================================
 *
 * GET /api/ws — WebSocket upgrade → UserDO (hibernation API)
 *
 * Pushes session status changes to all connected browsers for the
 * authenticated user. One WebSocket per browser tab.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
};

export const createRealtimeRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // WebSocket upgrades don't fit OpenAPI — kept as a plain route.
  router.get("/api/ws", async (c) => {
    const upgrade = c.req.header("Upgrade");
    if (upgrade !== "websocket") {
      return c.json({ error: "Expected WebSocket upgrade" }, 426);
    }

    // userDOStub is resolved by the auth middleware
    const userDOStub = c.get("userDOStub");
    return userDOStub.fetch(c.req.raw);
  });

  return router;
};
