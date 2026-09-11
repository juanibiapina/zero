import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  showUpDate: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  projectId: z.string().nullable(),
  takenOnAt: z.string().nullable(),
  sourceCaptureId: z.string().nullable(),
  // In practice every stored row is keyed; a null (unkeyed) row sorts last and
  // is tolerated rather than rejected so a stray/legacy null degrades
  // gracefully instead of 500ing the whole list response.
  sortKey: z.string().nullable(),
});

// A local calendar day, YYYY-MM-DD. The client mints it in the user's timezone.
const ShowUpDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createTasksRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "List the caller's open tasks",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ tasks: z.array(TaskSchema) }),
          },
        },
        description:
          "Open tasks (completedAt IS NULL), oldest first. The due-today date filter is applied client-side.",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const tasks = await userDO.listTasks();
    return c.json({ tasks }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "Add a task",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().uuid(),
              text: z.string().min(1),
              // Optional: a loose quick-capture has no day (null/absent = always
              // relevant). A project-screen add or a dated quick-add sends one.
              showUpDate: ShowUpDate.nullable().optional(),
              // Optional: the Project this task belongs to. Omitted/absent for a
              // loose task.
              projectId: z.string().uuid().nullable().optional(),
              // Optional: when the task was taken on (curated onto Home). The
              // Home quick-add sends a timestamp; a project-screen add omits it
              // (parked).
              takenOnAt: z.string().nullable().optional(),
              // Optional: the capture this task was refined from.
              sourceCaptureId: z.string().uuid().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The created task",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty text, non-UUID id, or malformed showUpDate",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, text, showUpDate, projectId, takenOnAt, sourceCaptureId } =
      c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const userDO = getUserDO(c.env, userId);
    const task = await userDO.addTask(
      id,
      text,
      showUpDate ?? null,
      projectId ?? null,
      takenOnAt ?? null,
      sourceCaptureId ?? null,
    );
    log("task_added", { clerk_user_id: userId });
    return c.json({ task }, 201);
  });

  const patchRoute = createRoute({
    method: "patch",
    path: "/api/tasks/{id}",
    tags: ["Tasks"],
    summary:
      "Update a task's text, show-up date, sort key, taken-on state, or project",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update: any field may be present. showUpDate may be null
            // to clear the date (make the task loose/always-relevant again).
            // takenOnAt: a timestamp to take on, or null to park. sortKey is a
            // client-minted fractional index (trusted, not charset validated).
            // In practice each PATCH carries exactly one intent. Idempotent on
            // the id, so a replayed offline write is safe.
            schema: z.object({
              text: z.string().min(1).optional(),
              showUpDate: ShowUpDate.nullable().optional(),
              sortKey: z.string().min(1).optional(),
              takenOnAt: z.string().nullable().optional(),
              // The Project to move the task into (uuid), or null to move it back
              // to loose. Present-not-value: null is a valid clear-to-loose.
              projectId: z.string().uuid().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The updated task",
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
        description: "No task with that id",
      },
    },
  });

  // PATCH (not a POST …/edit action) because updating a task's fields is a
  // genuine idempotent field update on its stable id. One endpoint carries
  // edit (text), reschedule (showUpDate), reorder (sortKey), and curation
  // (takenOnAt); each field maps to its own store verb.
  router.openapi(patchRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const hasText = body.text !== undefined;
    const hasShowUpDate = "showUpDate" in body;
    const hasSortKey = body.sortKey !== undefined;
    const hasTakenOn = "takenOnAt" in body;
    const hasProjectId = "projectId" in body;
    if (
      !hasText &&
      !hasShowUpDate &&
      !hasSortKey &&
      !hasTakenOn &&
      !hasProjectId
    ) {
      return c.json({ error: "no fields to update" }, 400);
    }

    const userDO = getUserDO(c.env, userId);
    let task: Awaited<ReturnType<typeof userDO.setTaskTakenOn>> = null;
    if (hasSortKey && body.sortKey !== undefined) {
      task = await userDO.reorderTask(id, body.sortKey);
      if (task) log("task_reordered", { clerk_user_id: userId });
    }
    if (hasShowUpDate) {
      task = await userDO.rescheduleTask(id, body.showUpDate ?? null);
      if (task) log("task_rescheduled", { clerk_user_id: userId });
    }
    if (hasText && body.text !== undefined) {
      task = await userDO.editTask(id, body.text);
      if (task) log("task_edited", { clerk_user_id: userId });
    }
    if (hasTakenOn) {
      task = await userDO.setTaskTakenOn(id, body.takenOnAt ?? null);
      if (task) log("task_taken_on", { clerk_user_id: userId });
    }
    if (hasProjectId) {
      task = await userDO.setTaskProject(id, body.projectId ?? null);
      if (task) log("task_moved", { clerk_user_id: userId });
    }
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task }, 200);
  });

  const completeRoute = createRoute({
    method: "post",
    path: "/api/tasks/{id}/complete",
    tags: ["Tasks"],
    summary: "Complete a task, removing it from the open list",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The task, now completed",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No task with that id",
      },
    },
  });

  router.openapi(completeRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const task = await userDO.completeTask(id);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    log("task_completed", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  const reopenRoute = createRoute({
    method: "post",
    path: "/api/tasks/{id}/reopen",
    tags: ["Tasks"],
    summary: "Reopen a completed task, returning it to the open list",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The task, now open (completedAt cleared)",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No task with that id",
      },
    },
  });

  // The inverse of complete: it backs the Undo on the Home task-complete
  // snackbar, so a mis-tapped completion is one tap to reverse. Idempotent on
  // the id (reopening an already-open task just re-clears a null completedAt).
  router.openapi(reopenRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const task = await userDO.reopenTask(id);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    log("task_reopened", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  return router;
};
