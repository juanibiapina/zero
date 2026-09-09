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
  showUpDate: z.string().nullable(),
  // Nullable: in practice every stored row is keyed, but a null (unkeyed) row
  // sorts last and is tolerated here rather than rejected — a stray/legacy null
  // degrades gracefully instead of 500ing the whole list response.
  sortKey: z.string().nullable(),
});

// A local calendar day, YYYY-MM-DD. The client mints it in the user's timezone.
const ShowUpDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createCapturesRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/captures",
    tags: ["Captures"],
    summary: "List the caller's Captures",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ captures: z.array(CaptureSchema) }),
          },
        },
        description: "The Captures, oldest first",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const captures = await userDO.listCaptures();
    return c.json({ captures }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/captures",
    tags: ["Captures"],
    summary: "Capture an item into Captures",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ id: z.string().uuid(), text: z.string().min(1) }),
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
    const { id, text } = c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const userDO = getUserDO(c.env, userId);
    const capture = await userDO.addCapture(id, text);
    log("capture_added", { clerk_user_id: userId });
    return c.json({ capture }, 201);
  });

  const processRoute = createRoute({
    method: "post",
    path: "/api/captures/{id}/process",
    tags: ["Captures"],
    summary: "Process a capture (GTD Clarify), removing it from Captures",
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

  const unprocessRoute = createRoute({
    method: "post",
    path: "/api/captures/{id}/unprocess",
    tags: ["Captures"],
    summary: "Unprocess a capture, returning it to the Captures inbox",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ capture: CaptureSchema }) },
        },
        description: "The capture, now open (processedAt cleared)",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No capture with that id",
      },
    },
  });

  // The inverse of process: it backs the Undo on the capture-complete snackbar,
  // so a mis-tapped process is one tap to reverse. Idempotent on the id.
  router.openapi(unprocessRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const capture = await userDO.unprocessCapture(id);
    if (!capture) {
      return c.json({ error: "capture not found" }, 404);
    }
    log("capture_unprocessed", { clerk_user_id: userId });
    return c.json({ capture }, 200);
  });

  const editRoute = createRoute({
    method: "patch",
    path: "/api/captures/{id}",
    tags: ["Captures"],
    summary: "Update a capture's text, show-up date and/or sort key",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update: any field may be present. showUpDate may be
            // null to clear the date (make the capture always visible again).
            // sortKey is a client-minted fractional index (trusted, not charset
            // validated). In practice each PATCH carries exactly one intent.
            schema: z.object({
              text: z.string().min(1).optional(),
              showUpDate: ShowUpDate.nullable().optional(),
              sortKey: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ capture: CaptureSchema }) },
        },
        description: "The updated capture",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty text, malformed date, or no fields to update",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No capture with that id",
      },
    },
  });

  // PATCH (not a POST …/edit action) because updating a capture's fields is a
  // genuine idempotent field update on its stable id. One endpoint carries both
  // edit (text) and reschedule (showUpDate). See docs/entities/capture.md.
  router.openapi(editRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const hasText = body.text !== undefined;
    const hasShowUpDate = "showUpDate" in body;
    const hasSortKey = body.sortKey !== undefined;
    if (!hasText && !hasShowUpDate && !hasSortKey) {
      return c.json({ error: "no fields to update" }, 400);
    }

    const userDO = getUserDO(c.env, userId);
    let capture: Awaited<ReturnType<typeof userDO.editCapture>> = null;
    if (hasSortKey && body.sortKey !== undefined) {
      capture = await userDO.reorderCapture(id, body.sortKey);
      if (capture) log("capture_reordered", { clerk_user_id: userId });
    }
    if (hasShowUpDate) {
      capture = await userDO.rescheduleCapture(id, body.showUpDate ?? null);
      if (capture) log("capture_rescheduled", { clerk_user_id: userId });
    }
    if (hasText && body.text !== undefined) {
      capture = await userDO.editCapture(id, body.text);
      if (capture) log("capture_edited", { clerk_user_id: userId });
    }
    if (!capture) {
      return c.json({ error: "capture not found" }, 404);
    }
    return c.json({ capture }, 200);
  });

  return router;
};
