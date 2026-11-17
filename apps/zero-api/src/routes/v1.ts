import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { findTodoOperation, type OperationOutcome } from "@zero/agent-core/operations";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { clerkClient } from "../clerk";
import { log } from "../log";
import { getTaskDO } from "../TaskDO/stub";
import { userToday, type ResolveToday } from "../today";
import type { Env } from "../types";

type V1 = { Bindings: Env; Variables: { userId: string } };
type ErrorStatus = 400 | 404 | 409;
type Conflicts = Partial<Record<string, ErrorStatus>>;

const catalogInput = (name: string) => {
  const operation = findTodoOperation(name);
  if (!operation) throw new Error(`missing catalog operation ${name}`);
  return operation.input;
};

const ProjectState = z.enum(["in-play", "backlog", "done"]);

const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  showUpDate: z.string().nullable(),
  recurrence: z.unknown().nullable(),
  recurrenceDate: z.string().nullable(),
  parent: z.unknown().nullable(),
  recordingId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
}).loose();

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  description: z.string().nullable(),
  state: ProjectState,
  attention: z.enum(["active", "next", "waiting", "after", "backlog", "done"]).optional(),
  createdAt: z.string(),
}).loose();

const ErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
const IdParams = z.object({ id: z.string().min(1) });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const errors = (described: Partial<Record<ErrorStatus | 401, string>>) =>
  Object.fromEntries(Object.entries({ 401: "Missing or invalid OAuth access token", ...described })
    .map(([status, description]) => [status, json(ErrorSchema, description)]));

const unauthorized = (c: Context) =>
  c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

const authenticate: MiddlewareHandler<V1> = async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return unauthorized(c);
  if (c.env.ENVIRONMENT === "test") {
    c.set("userId", token);
    return next();
  }
  const state = await clerkClient(c.env).authenticateRequest(c.req.raw, { acceptsToken: "oauth_token" });
  const auth = state.toAuth();
  if (!auth?.isAuthenticated || auth.tokenType !== "oauth_token" || !auth.userId) return unauthorized(c);
  c.set("userId", auth.userId);
  return next();
};

const TASK_CONFLICTS: Conflicts = {
  "missing-task": 404,
  "missing-project": 409,
  "missing-recording": 409,
  "id-conflict": 409,
  "invalid-recurrence": 409,
};

export const createV1Routes = ({ resolveToday = userToday }: { resolveToday?: ResolveToday } = {}) => {
  const router = new OpenAPIHono<V1>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid-request", message: z.prettifyError(result.error) }, 400);
      }
    },
  });

  const run = async (c: Context<V1>, name: string, input: unknown): Promise<OperationOutcome> => {
    const userId = c.get("userId");
    const today = await resolveToday(c.env, userId);
    const outcome = await getTaskDO(c.env, userId).runOperation(name, input, today);
    log("api_v1_called", { clerk_user_id: userId, operation: name, ok: outcome.ok });
    return outcome;
  };

  const refuse = (c: Context<V1>, error: string, conflicts: Conflicts): never =>
    c.json({ error }, conflicts[error] ?? 400) as never;

  router.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: "OAuth access token from Zero's Clerk instance",
  });
  router.doc31("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Zero todo API", version: "1.0.0" },
    security: [{ bearer: [] }],
  });

  router.use("/api/v1/*", authenticate);

  router.openapi(createRoute({
    method: "get",
    path: "/api/v1/tasks",
    tags: ["Tasks"],
    summary: "List Tasks not completed",
    request: {
      query: z.object({
        view: z.enum(["all", "home"]).optional().describe("home: exactly the Tasks on Home today"),
        projectId: z.string().min(1).optional().describe("Only the Tasks of this Project"),
      }),
    },
    responses: {
      200: json(z.object({ today: z.string(), tasks: z.array(TaskSchema) }), "Tasks in the user's order"),
      ...errors({ 400: "Invalid query" }),
    },
  }), async (c) => {
    const { view, projectId } = c.req.valid("query");
    const outcome = await run(c, "tasks_list", {
      ...(view ? { view } : {}),
      ...(projectId ? { parent: { kind: "project", projectId } } : {}),
    });
    if (!outcome.ok) return refuse(c, outcome.error, {});
    return c.json(outcome.value as never, 200);
  });

  router.openapi(createRoute({
    method: "post",
    path: "/api/v1/tasks",
    tags: ["Tasks"],
    summary: "Create a Task",
    request: { body: { content: { "application/json": { schema: catalogInput("tasks_create") } }, required: true } },
    responses: {
      201: json(z.object({ task: TaskSchema }), "The created Task"),
      ...errors({ 400: "Invalid body", 409: "The id is taken, or the Project or Recording does not exist" }),
    },
  }), async (c) => {
    const outcome = await run(c, "tasks_create", c.req.valid("json"));
    if (!outcome.ok) return refuse(c, outcome.error, TASK_CONFLICTS);
    return c.json({ task: outcome.value } as never, 201);
  });

  router.openapi(createRoute({
    method: "patch",
    path: "/api/v1/tasks/{id}",
    tags: ["Tasks"],
    summary: "Change a Task's text, showUpDate, Project, or Recording",
    request: {
      params: IdParams,
      body: { content: { "application/json": { schema: catalogInput("tasks_update").omit({ id: true }) } }, required: true },
    },
    responses: {
      200: json(z.object({ task: TaskSchema }), "The updated Task"),
      ...errors({ 400: "Invalid body or nothing to update", 404: "No such Task", 409: "The Project or Recording does not exist" }),
    },
  }), async (c) => {
    const outcome = await run(c, "tasks_update", { id: c.req.valid("param").id, ...c.req.valid("json") });
    if (!outcome.ok) return refuse(c, outcome.error, TASK_CONFLICTS);
    return c.json({ task: outcome.value } as never, 200);
  });

  for (const [action, operation, summary] of [
    ["complete", "tasks_complete", "Complete a Task; a recurring Task advances to its next occurrence"],
    ["reopen", "tasks_reopen", "Reopen a completed Task"],
  ] as const) {
    router.openapi(createRoute({
      method: "post",
      path: `/api/v1/tasks/{id}/${action}`,
      tags: ["Tasks"],
      summary,
      request: { params: IdParams },
      responses: {
        200: json(z.object({ task: TaskSchema }), "The Task"),
        ...errors({ 404: "No such Task", 409: "The recurrence is invalid" }),
      },
    }), async (c) => {
      const outcome = await run(c, operation, { id: c.req.valid("param").id });
      if (!outcome.ok) return refuse(c, outcome.error, TASK_CONFLICTS);
      return c.json({ task: outcome.value } as never, 200);
    });
  }

  router.openapi(createRoute({
    method: "get",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "List Projects with their attention",
    request: {
      query: z.object({
        includeDone: z.enum(["true", "false"]).optional().describe("Also list done Projects"),
      }),
    },
    responses: {
      200: json(z.object({ today: z.string(), projects: z.array(ProjectSchema) }), "Projects"),
      ...errors({ 400: "Invalid query" }),
    },
  }), async (c) => {
    const { includeDone } = c.req.valid("query");
    const outcome = await run(c, "projects_list", includeDone === "true" ? { includeDone: true } : {});
    if (!outcome.ok) return refuse(c, outcome.error, {});
    return c.json(outcome.value as never, 200);
  });

  router.openapi(createRoute({
    method: "post",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "Create a Project",
    request: { body: { content: { "application/json": { schema: catalogInput("projects_create") } }, required: true } },
    responses: {
      201: json(z.object({ project: ProjectSchema }), "The created Project"),
      ...errors({ 400: "Invalid body", 409: "The id is taken" }),
    },
  }), async (c) => {
    const outcome = await run(c, "projects_create", c.req.valid("json"));
    if (!outcome.ok) return refuse(c, outcome.error, { "id-conflict": 409 });
    return c.json({ project: outcome.value } as never, 201);
  });

  router.openapi(createRoute({
    method: "patch",
    path: "/api/v1/projects/{id}",
    tags: ["Projects"],
    summary: "Change a Project's title, icon, description, or state",
    request: {
      params: IdParams,
      body: {
        content: {
          "application/json": {
            schema: catalogInput("projects_edit").omit({ id: true }).extend({ state: ProjectState.optional() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(z.object({ project: ProjectSchema }), "The updated Project"),
      ...errors({ 400: "Invalid body or nothing to update", 404: "No such Project" }),
    },
  }), async (c) => {
    const { id } = c.req.valid("param");
    const { state, ...fields } = c.req.valid("json") as { state?: string } & Record<string, unknown>;
    const conflicts: Conflicts = { "missing-project": 404 };
    if (state === undefined && Object.keys(fields).length === 0) return refuse(c, "nothing to update", conflicts);
    let project: unknown;
    if (Object.keys(fields).length > 0) {
      const outcome = await run(c, "projects_edit", { id, ...fields });
      if (!outcome.ok) return refuse(c, outcome.error, conflicts);
      project = outcome.value;
    }
    if (state !== undefined) {
      const outcome = await run(c, "projects_set_state", { id, state });
      if (!outcome.ok) return refuse(c, outcome.error, conflicts);
      project = outcome.value;
    }
    return c.json({ project } as never, 200);
  });

  router.openapi(createRoute({
    method: "delete",
    path: "/api/v1/projects/{id}",
    tags: ["Projects"],
    summary: "Delete a Project with its Tasks, Waiting conditions, and Afters",
    request: { params: IdParams },
    responses: {
      200: json(
        z.object({ removed: z.object({ tasks: z.number(), conditions: z.number(), afters: z.number() }) }),
        "How many of each were removed; deleting a missing Project removes nothing",
      ),
      ...errors({}),
    },
  }), async (c) => {
    const outcome = await run(c, "projects_delete", { id: c.req.valid("param").id });
    if (!outcome.ok) return refuse(c, outcome.error, {});
    return c.json({ removed: outcome.value } as never, 200);
  });

  router.all("/api/v1/*", (c) => c.json({ error: "not-found" }, 404));

  return router;
};
