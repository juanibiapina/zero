import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
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
});

export const createProjectsRoutes = () => {
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
    const { id, title, icon, description, status } = c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const userDO = getUserDO(c.env, userId);
    const project = await userDO.addProject(id, title, {
      icon,
      description,
      status,
    });
    log("project_added", { clerk_user_id: userId });
    return c.json({ project }, 201);
  });

  const editRoute = createRoute({
    method: "patch",
    path: "/api/projects/{id}",
    tags: ["Projects"],
    summary: "Change a project's status",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // A partial update on the project's stable id. A2 carries only
            // `status`; A3 widens this to title/icon/description. Setting `done`
            // drops the row from the working list.
            schema: z.object({ status: ProjectStatus.optional() }),
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
        description: "No fields to update or an unknown status",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No project with that id",
      },
    },
  });

  // PATCH (not a POST …/action) because changing a project's status is an
  // idempotent field update on its stable id. One endpoint carries every status
  // transition; A3 will widen the same body to the edit fields. See
  // docs/entities/project.md.
  router.openapi(editRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    if (status === undefined) {
      return c.json({ error: "no fields to update" }, 400);
    }
    const userDO = getUserDO(c.env, userId);
    const project = await userDO.setProjectStatus(id, status);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    log("project_status_changed", { clerk_user_id: userId });
    return c.json({ project }, 200);
  });

  return router;
};
