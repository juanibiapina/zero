import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
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

const ProjectStatus = z.enum([
  "active",
  "next",
  "waiting",
  "backlog",
  "done",
]);

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  description: z.string().nullable(),
  status: ProjectStatus,
  createdAt: z.string(),
  sourceCaptureId: z.string().nullable(),
});

export const createProjectsRoutes = (
  deps: { suggestIcons?: SuggestIcons } = {},
) => {
  const suggestIcons = deps.suggestIcons ?? defaultSuggestIcons;
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

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
    const userDO = getUserDO(c.env, userId);
    const projects = await userDO.listProjects();
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
              // these defaults (icon 📁, description null, status next).
              icon: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
              status: ProjectStatus.optional(),
              // Optional: the capture this project was refined from.
              sourceCaptureId: z.string().uuid().nullable().optional(),
            }),
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
        description: "Empty title, non-UUID id, or an unknown status",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, title, icon, description, status, sourceCaptureId } =
      c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const userDO = getUserDO(c.env, userId);
    const project = await userDO.addProject(id, title, {
      icon,
      description,
      status,
      sourceCaptureId,
    });
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
    summary: "Edit a project or change its status",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update on the project's stable id. It carries either the
            // status transition (`status`, where `done` drops the row from the
            // working list) or the editable fields (title/icon/description), or
            // both. Empty title/icon are rejected; description may be null.
            schema: z.object({
              status: ProjectStatus.optional(),
              title: z.string().min(1).optional(),
              icon: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
            }),
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
        description: "No fields to update, or an empty title/icon or bad status",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No project with that id",
      },
    },
  });

  // PATCH (not a POST …/action) because both editing a project and changing its
  // status are idempotent field updates on its stable id. One endpoint carries
  // every transition and every edit: the edit fields go through `editProject`,
  // the status transition through `setProjectStatus`. See
  // docs/entities/project.md.
  router.openapi(editRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { status, title, icon, description } = c.req.valid("json");
    const editFields: {
      title?: string;
      icon?: string;
      description?: string | null;
    } = {};
    if (title !== undefined) editFields.title = title;
    if (icon !== undefined) editFields.icon = icon;
    if (description !== undefined) editFields.description = description;
    const hasEdit = Object.keys(editFields).length > 0;
    if (!hasEdit && status === undefined) {
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
    if (status !== undefined) {
      project = await userDO.setProjectStatus(id, status);
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }
      log("project_status_changed", { clerk_user_id: userId });
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

  // DELETE hard-removes the project (distinct from PATCH status 'done', which
  // keeps the row out of the working list). Idempotent on the id: a missing row
  // still returns 204, so a replayed offline delete (a retry after a lost ACK)
  // never makes the client's outbox throw and retry forever. Unlike the PATCH
  // route there is no 404.
  router.openapi(deleteRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    await userDO.deleteProject(id);
    log("project_deleted", { clerk_user_id: userId });
    return c.body(null, 204);
  });

  return router;
};
