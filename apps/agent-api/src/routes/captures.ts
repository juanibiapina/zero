import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const CaptureSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  processedAt: z.string().nullable(),
});

export const createCapturesRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/captures",
    tags: ["Captures"],
    summary: "List the caller's Inbox",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ captures: z.array(CaptureSchema) }),
          },
        },
        description: "The Inbox, oldest first",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const captures = await userDO.listInbox();
    return c.json({ captures }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/captures",
    tags: ["Captures"],
    summary: "Capture an item into the Inbox",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ text: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ capture: CaptureSchema }) },
        },
        description: "The created capture",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty or missing text",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { text } = c.req.valid("json");
    const userDO = getUserDO(c.env, userId);
    const capture = await userDO.addCapture(text);
    log("capture_added", { clerk_user_id: userId });
    return c.json({ capture }, 201);
  });

  const processRoute = createRoute({
    method: "post",
    path: "/api/captures/{id}/process",
    tags: ["Captures"],
    summary: "Process a capture (GTD Clarify), removing it from the Inbox",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ capture: CaptureSchema }) },
        },
        description: "The capture, now processed",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No capture with that id",
      },
    },
  });

  router.openapi(processRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const capture = await userDO.processCapture(id);
    if (!capture) {
      return c.json({ error: "capture not found" }, 404);
    }
    log("capture_processed", { clerk_user_id: userId });
    return c.json({ capture }, 200);
  });

  return router;
};
