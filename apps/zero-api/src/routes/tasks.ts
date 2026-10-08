import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  validateRecurrence,
  type Recurrence,
} from "@zeroapps/recurrence";

import { log } from "../log";
import type { Env } from "../types";
import { getTaskDO } from "../TaskDO/stub";
import { suggestProject, type ProjectSuggestion } from "../agents/project-suggest";
import { typesafeDecide } from "@zeroapps/typesafe";

type Variables = {
  userId: string;
};

const PlainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RecurrenceInput = z.custom<Recurrence>(
  (value) => validateRecurrence(value).ok,
  "invalid recurrence",
);

const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  showUpDate: PlainDate.nullable(),
  recurrence: RecurrenceInput.nullable(),
  recurrenceDate: PlainDate.nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  parent: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project"), projectId: z.string() }),
    z.object({ kind: z.literal("medicine"), medicineId: z.string(), role: z.literal("restock").nullable() }),
  ]).nullable(),
  // In practice every stored row is keyed; a null (unkeyed) row sorts last and
  // is tolerated rather than rejected so a stray/legacy null degrades
  // gracefully instead of 500ing the whole list response.
  sortKey: z.string().nullable(),
});

export type SuggestTaskProject = (
  env: Env,
  userId: string,
  input: Parameters<typeof suggestProject>[1],
) => Promise<ProjectSuggestion>;

const defaultSuggestProject: SuggestTaskProject = (env, _userId, input) =>
  suggestProject(typesafeDecide(env.TYPESAFE_API_KEY), input);

// Only a Project parent can be set over REST; a Medicine adds its own Tasks.
const ParentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
]);

const ProjectCandidateSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  icon: z.string().max(32),
  description: z.string().max(300).nullable(),
  tasks: z.array(z.string().max(200)).max(5),
});

export const createTasksRoutes = (
  deps: { suggestProject?: SuggestTaskProject } = {},
) => {
  const suggest = deps.suggestProject ?? defaultSuggestProject;
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
    const tasks = await getTaskDO(c.env, userId).listTasks();
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
              // Optional: a loose quick-add has no day (null/absent = always
              // relevant). A project-screen add or a dated quick-add sends one.
              showUpDate: PlainDate.nullable().optional(),
              recurrence: RecurrenceInput.nullable().optional(),
              // Optional: the Project this task belongs to. Omitted/absent for a
              // loose task.
              parent: ParentInput.nullable().optional(),
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
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "The referenced Project is missing or deleted",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, text, showUpDate, recurrence, parent } =
      c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const task = await getTaskDO(c.env, userId).addTask(
      id, text, showUpDate ?? null, parent ?? null, recurrence ?? null,
    );
    if (!task) return c.json({ error: "task id is in use or project not found" }, 409);
    log("task_added", { clerk_user_id: userId });
    return c.json({ task }, 201);
  });

  const patchRoute = createRoute({
    method: "patch",
    path: "/api/tasks/{id}",
    tags: ["Tasks"],
    summary:
      "Update a task's text, show-up date, sort key, or project",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update: any field may be present. showUpDate may be null
            // to clear the date (make the task loose/always-relevant again).
            // sortKey is a client-minted fractional index (trusted, not charset
            // validated). In practice each PATCH carries exactly one intent.
            // Idempotent on the id, so a replayed offline write is safe.
            schema: z.object({
              text: z.string().min(1).optional(),
              showUpDate: PlainDate.nullable().optional(),
              sortKey: z.string().min(1).optional(),
              // The Project to move the task into, or null to move it back
              // to loose. Present-not-value: null is a valid clear-to-loose.
              parent: ParentInput.nullable().optional(),
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
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "The referenced Project is missing or deleted",
      },
    },
  });

  // PATCH (not a POST …/edit action) because updating a task's fields is a
  // genuine idempotent field update on its stable id. One endpoint carries
  // edit (text), reschedule (showUpDate), reorder (sortKey), and move-to-project
  // (parent); each field maps to its own store verb.
  router.openapi(patchRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const hasText = body.text !== undefined;
    const hasShowUpDate = "showUpDate" in body;
    const hasSortKey = body.sortKey !== undefined;
    const hasParent = "parent" in body;
    if (!hasText && !hasShowUpDate && !hasSortKey && !hasParent) {
      return c.json({ error: "no fields to update" }, 400);
    }

    const task = await getTaskDO(c.env, userId).patchTask(id, body);
    if (task === "missing-project") return c.json({ error: "project not found" }, 409);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (hasSortKey) log("task_reordered", { clerk_user_id: userId });
    if (hasShowUpDate) log("task_rescheduled", { clerk_user_id: userId });
    if (hasText) log("task_edited", { clerk_user_id: userId });
    if (hasParent) log("task_moved", { clerk_user_id: userId });
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
    const task = await getTaskDO(c.env, userId).completeTask(id);
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
    const task = await getTaskDO(c.env, userId).reopenTask(id);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    log("task_reopened", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  const recurrenceRoute = createRoute({
    method: "put",
    path: "/api/tasks/{id}/recurrence",
    tags: ["Tasks"],
    summary: "Replace or clear a task recurrence",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ recurrence: RecurrenceInput.nullable() }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ task: TaskSchema }) } },
        description: "The updated task",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No task with that id",
      },
    },
  });

  router.openapi(recurrenceRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { recurrence } = c.req.valid("json");
    const task = await getTaskDO(c.env, userId).setTaskRecurrence(id, recurrence);
    if (!task) return c.json({ error: "task not found" }, 404);
    log("task_recurrence_changed", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  const completeOccurrenceRoute = createRoute({
    method: "post",
    path: "/api/tasks/{id}/complete-occurrence",
    tags: ["Tasks"],
    summary: "Complete one recurring occurrence",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ scheduledOn: PlainDate, completedOn: PlainDate }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ task: TaskSchema }) } },
        description: "The task advanced or completed at the recurrence end",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No task with that id",
      },
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "The synced recurrence is invalid",
      },
    },
  });

  router.openapi(completeOccurrenceRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { scheduledOn, completedOn } = c.req.valid("json");
    const task = await getTaskDO(c.env, userId).completeTaskOccurrence(id, scheduledOn, completedOn);
    if (task === "invalid-recurrence") return c.json({ error: "invalid stored recurrence" }, 409);
    if (!task) return c.json({ error: "task not found" }, 404);
    log("task_occurrence_completed", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  const undoOccurrenceRoute = createRoute({
    method: "post",
    path: "/api/tasks/{id}/undo-occurrence",
    tags: ["Tasks"],
    summary: "Undo the latest recurring occurrence completion",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expectedRecurrenceDate: PlainDate,
              recurrenceDateBefore: PlainDate,
              showUpDateBefore: PlainDate.nullable(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ task: TaskSchema }) } },
        description: "The restored task",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No task with that id",
      },
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "The synced recurrence is invalid",
      },
    },
  });

  router.openapi(undoOccurrenceRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const {
      expectedRecurrenceDate,
      recurrenceDateBefore,
      showUpDateBefore,
    } = c.req.valid("json");
    const task = await getTaskDO(c.env, userId).undoTaskOccurrence(
      id, expectedRecurrenceDate, recurrenceDateBefore, showUpDateBefore,
    );
    if (task === "invalid-recurrence") return c.json({ error: "invalid stored recurrence" }, 409);
    if (!task) return c.json({ error: "task not found" }, 404);
    log("task_occurrence_undone", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  const projectSuggestionRoute = createRoute({
    method: "post",
    path: "/api/tasks/project-suggestion",
    tags: ["Tasks"],
    summary: "Suggest the Project a Task being typed belongs to",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().trim().min(1).max(200),
              projects: z.array(ProjectCandidateSchema).min(1).max(254),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ projectId: z.string().nullable() }),
          },
        },
        description: "The suggested Project id; null is a soft miss.",
      },
    },
  });

  router.openapi(projectSuggestionRoute, async (c) => {
    const userId = c.get("userId");
    const input = c.req.valid("json");
    const started = Date.now();
    const suggestion = await suggest(c.env, userId, input);
    log("task_project_suggested", {
      clerk_user_id: userId,
      suggested: suggestion.projectId !== null,
      confidence: suggestion.confidence,
      latency_ms: Date.now() - started,
      input_tokens: suggestion.inputTokens,
      candidates: input.projects.length,
    });
    const projectId = input.projects.some((project) => project.id === suggestion.projectId)
      ? suggestion.projectId
      : null;
    return c.json({ projectId }, 200);
  });

  return router;
};
