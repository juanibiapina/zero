import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import { getTaskDO, isTaskDOFixture } from "../TaskDO/stub";
import { createModel } from "../agents/model";
import { suggestProjectIcons } from "../agents/icon-suggest";

type Variables = {
  userId: string;
};

// The AI icon-suggestion seam, injectable so the route is testable without a
// real model. The default builds a per-user model tagged `icon_suggest` (low
// effort) and asks it for emoji; it never throws (a soft miss returns []).
export type SuggestIcons = (
  env: Env,
  userId: string,
  input: { title: string; description?: string | null },
) => Promise<string[]>;

const defaultSuggestIcons: SuggestIcons = async (env, userId, input) => {
  const model = await createModel(env, userId, "icon_suggest");
  return suggestProjectIcons(model, input);
};

const ProjectState = z.enum(["in-play", "backlog", "done"]);

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  description: z.string().nullable(),
  state: ProjectState,
  createdAt: z.string(),
  sourceCaptureId: z.string().nullable(),
});

export const createProjectsRoutes = (
  deps: { suggestIcons?: SuggestIcons } = {},
) => {
  const suggestIcons = deps.suggestIcons ?? defaultSuggestIcons;
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
  router.use("/api/projects", async (c, next) => {
    if (isTaskDOFixture(c.env, c.get("userId")) && !["GET", "POST"].includes(c.req.method)) {
      return c.json({ error: "not supported for TaskDO fixture" }, 409);
    }
    await next();
  });
  router.use("/api/projects/*", async (c, next) => {
    if (isTaskDOFixture(c.env, c.get("userId")) && c.req.path !== "/api/projects" &&
      !(c.req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(c.req.path))) {
      return c.json({ error: "not supported for TaskDO fixture" }, 409);
    }
    await next();
  });

  const listRoute = createRoute({
    method: "get",
    path: "/api/projects",
    tags: ["Projects"],
    summary: "List the caller's projects",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ projects: z.array(ProjectSchema) }),
          },
        },
        description: "Projects, oldest first.",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const projects = isTaskDOFixture(c.env, userId)
      ? await getTaskDO(c.env, userId).listProjects()
      : await getUserDO(c.env, userId).listProjects();
    return c.json({ projects }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/projects",
    tags: ["Projects"],
    summary: "Add a project",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().uuid(),
              title: z.string().min(1),
              // The client normally sends only id + title; the server fills
              // these defaults (icon 📁, description null, state in-play).
              icon: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
              state: ProjectState.optional(),
              // Optional: the capture this project was refined from.
              sourceCaptureId: z.string().uuid().nullable().optional(),
            }).strict(),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ project: ProjectSchema }) },
        },
        description: "The created project",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty title, non-UUID id, or an unknown state",
      },
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "The Project id was deleted",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, title, icon, description, state, sourceCaptureId } =
      c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const project = isTaskDOFixture(c.env, userId)
      ? await getTaskDO(c.env, userId).addProject(id, title, { icon, description, state, sourceCaptureId })
      : await getUserDO(c.env, userId).addProject(id, title, { icon, description, state, sourceCaptureId });
    if (!project) return c.json({ error: "project was deleted" }, 409);
    log("project_added", { clerk_user_id: userId });
    return c.json({ project }, 201);
  });

  const iconSuggestRoute = createRoute({
    method: "post",
    path: "/api/projects/icon-suggestions",
    tags: ["Projects"],
    summary: "Suggest emoji icons for a project from its title/description",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              description: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ icons: z.array(z.string()) }),
          },
        },
        description:
          "Suggested single-emoji icons; an empty array is a soft miss.",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty title",
      },
    },
  });

  // Stateless on purpose: it reads/writes no `projects` row, so it is a plain
  // route (not a collection verb). Both the create-time pre-warm and the
  // fetch-on-open fallback call it. A soft miss (`[]`) is a 200; only an
  // unexpected throw is a 500.
  router.openapi(iconSuggestRoute, async (c) => {
    const userId = c.get("userId");
    const { title, description } = c.req.valid("json");
    const icons = await suggestIcons(c.env, userId, { title, description });
    log("project_icon_suggested", { clerk_user_id: userId, count: icons.length });
    return c.json({ icons }, 200);
  });

  const editRoute = createRoute({
    method: "patch",
    path: "/api/projects/{id}",
    tags: ["Projects"],
    summary: "Edit a project or change its lifecycle state",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update on the project's stable id. It carries either the
            // lifecycle transition (`state`, where `done` drops the row from the
            // working list) or editable fields, or both.
            schema: z.object({
              state: ProjectState.optional(),
              title: z.string().min(1).optional(),
              icon: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
            }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ project: ProjectSchema }) },
        },
        description: "The updated project",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No fields to update, or an empty title/icon or bad state",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No project with that id",
      },
    },
  });

  // PATCH carries idempotent edits and deliberate lifecycle-state transitions
  // on the stable project id. Display status remains client-derived. See
  // docs/entities/project.md.
  router.openapi(editRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { state, title, icon, description } = c.req.valid("json");
    const editFields: {
      title?: string;
      icon?: string;
      description?: string | null;
    } = {};
    if (title !== undefined) editFields.title = title;
    if (icon !== undefined) editFields.icon = icon;
    if (description !== undefined) editFields.description = description;
    const hasEdit = Object.keys(editFields).length > 0;
    if (!hasEdit && state === undefined) {
      return c.json({ error: "no fields to update" }, 400);
    }
    const userDO = getUserDO(c.env, userId);
    let project: Awaited<ReturnType<typeof userDO.editProject>> = null;
    if (hasEdit) {
      project = await userDO.editProject(id, editFields);
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }
      log("project_edited", { clerk_user_id: userId });
    }
    if (state !== undefined) {
      project = await userDO.setProjectState(id, state);
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }
      log("project_state_changed", { clerk_user_id: userId });
    }
    // Unreachable: the empty-body case returned 400 above, so at least one branch
    // set `project`. The guard narrows it to non-null for the typed response.
    if (!project) {
      return c.json({ error: "no fields to update" }, 400);
    }
    return c.json({ project }, 200);
  });

  const deleteRoute = createRoute({
    method: "delete",
    path: "/api/projects/{id}",
    tags: ["Projects"],
    summary: "Permanently delete a project",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      204: {
        description: "Deleted (or already absent)",
      },
    },
  });

  // DELETE hard-removes the project (distinct from PATCH state 'done', which
  // keeps the row out of the working list) and cascades to its tasks and waiting
  // conditions (UserDO.deleteProject). Idempotent on the id: a missing row still
  // returns 204, so a replayed offline delete (a retry after a lost ACK) never
  // makes the client's outbox throw and retry forever. Unlike the PATCH route
  // there is no 404. The cascade counts ride the log so a delete is observable.
  router.openapi(deleteRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { tasks, conditions, afters } = isTaskDOFixture(c.env, userId)
      ? await getTaskDO(c.env, userId).deleteProject(id)
      : await getUserDO(c.env, userId).deleteProject(id);
    log("project_deleted", {
      clerk_user_id: userId,
      tasks,
      conditions,
      after_relationships: afters,
    });
    return c.body(null, 204);
  });

  return router;
};
