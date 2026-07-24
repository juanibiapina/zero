// Admin-only routes for the user roster and per-user diagnostics.
//
// Gated by the ADMIN_USER_ID env var — only the matching Clerk user can access
// these endpoints. Per-request cost tracking was removed with the container
// runtime; the Cloudflare AI Gateway now logs per-user model/token/USD cost,
// attributed via the `cf-aig-metadata` we send. Re-add an in-app cost view from
// the gateway logs later if wanted.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { getGithubInstallationStatus } from "../github-token";
import { listClerkUsers, getClerkUser } from "../admin-users";
import { getUserDO } from "../UserDO/stub";
import { log } from "../log";

type Variables = {
  userId: string;
};

const AdminUserSchema = z.object({
  clerkUserId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  createdAt: z.string(),
});

const AdminUserDetailSchema = z.object({
  clerkUserId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  createdAt: z.string(),
  telegramId: z.string().nullable(),
  googleOnboardingStatus: z.string().nullable(),
  onboardingSeen: z.boolean(),
});

export const createAdminRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // Admin gate — runs before all /api/admin/* routes
  router.use("/api/admin/*", async (c, next) => {
    const userId = c.get("userId");
    if (userId !== c.env.ADMIN_USER_ID) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });

  // GET /api/admin/users — complete roster from Clerk.
  const usersRoute = createRoute({
    method: "get",
    path: "/api/admin/users",
    tags: ["Admin"],
    summary: "List all users",
    responses: {
      200: {
        content: { "application/json": { schema: z.array(AdminUserSchema) } },
        description: "All users",
      },
    },
  });

  router.openapi(usersRoute, async (c) => {
    const users = await listClerkUsers(c.env);
    return c.json(
      users.map((u) => ({
        clerkUserId: u.clerkUserId,
        email: u.email,
        username: u.username,
        createdAt: u.createdAt,
      })),
      200,
    );
  });

  // GET /api/admin/users/{userId} — per-user identity and link status.
  const userDetailRoute = createRoute({
    method: "get",
    path: "/api/admin/users/{userId}",
    tags: ["Admin"],
    summary: "Get a single user's identity and link status",
    request: {
      params: z.object({ userId: z.string().min(1) }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: AdminUserDetailSchema } },
        description: "User identity and link status",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Unknown user",
      },
    },
  });

  router.openapi(userDetailRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const identity = await getClerkUser(c.env, userId);
    if (!identity) {
      return c.json({ error: "Unknown user" }, 404);
    }
    const userDO = getUserDO(c.env, userId);
    const [telegramId, settings] = await Promise.all([
      userDO.getTelegramId(),
      userDO.getSettings(),
    ]);
    return c.json({
      clerkUserId: identity.clerkUserId,
      email: identity.email,
      username: identity.username,
      createdAt: identity.createdAt,
      telegramId,
      googleOnboardingStatus: settings.googleOnboardingStatus,
      onboardingSeen: settings.onboardingSeen,
    }, 200);
  });

  const ErrorSchema = z.object({ error: z.string() });
  const AdminTaskRequestSchema = z.object({
    prompt: z
      .string()
      .max(20_000)
      .refine((prompt) => prompt.trim().length > 0, "prompt cannot be blank"),
  });
  const AdminTaskStatusSchema = z.discriminatedUnion("status", [
    z.object({ clerkUserId: z.string(), status: z.literal("queued") }),
    z.object({
      clerkUserId: z.string(),
      status: z.literal("done"),
      summary: z.string().max(1_000),
    }),
    z.object({ clerkUserId: z.string(), status: z.literal("failed") }),
  ]);

  // POST /api/admin/users/{userId}/task — queue one off-Telegram task.
  // Clerk remains the authority for the target.
  const postAdminTaskRoute = createRoute({
    method: "post",
    path: "/api/admin/users/{userId}/task",
    tags: ["Admin"],
    summary: "Queue a one-off admin task for a user",
    request: {
      params: z.object({ userId: z.string().min(1) }),
      body: { content: { "application/json": { schema: AdminTaskRequestSchema } } },
    },
    responses: {
      202: { description: "Admin task queued" },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Invalid task prompt",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unknown user",
      },
      409: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin task already queued",
      },
    },
  });

  router.openapi(postAdminTaskRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const { prompt } = c.req.valid("json");
    if (!(await getClerkUser(c.env, userId))) {
      log("admin_task_rejected", {
        clerk_user_id: userId,
        prompt_length: prompt.length,
        status: "unknown_user",
      });
      return c.json({ error: "Unknown user" }, 404);
    }

    const queued = await getUserDO(c.env, userId).queueAdminTask({
      clerkUserId: userId,
      prompt,
    });
    log(queued ? "admin_task_queued" : "admin_task_rejected", {
      clerk_user_id: userId,
      prompt_length: prompt.length,
      status: queued ? "queued" : "queued_conflict",
    });
    if (!queued) return c.json({ error: "Admin task already queued" }, 409);
    return c.body(null, 202);
  });

  // GET /api/admin/users/{userId}/task — task status only. The prompt
  // is intentionally absent even for the authenticated administrator.
  const getAdminTaskRoute = createRoute({
    method: "get",
    path: "/api/admin/users/{userId}/task",
    tags: ["Admin"],
    summary: "Get a user's one-off admin task status",
    request: { params: z.object({ userId: z.string().min(1) }) },
    responses: {
      200: {
        content: { "application/json": { schema: AdminTaskStatusSchema } },
        description: "Non-sensitive task status",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unknown user or no admin task",
      },
    },
  });

  router.openapi(getAdminTaskRoute, async (c) => {
    const { userId } = c.req.valid("param");
    if (!(await getClerkUser(c.env, userId))) {
      log("admin_task_status", { clerk_user_id: userId, status: "unknown_user" });
      return c.json({ error: "Unknown user" }, 404);
    }

    const status = await getUserDO(c.env, userId).getAdminTaskStatus();
    log("admin_task_status", {
      clerk_user_id: userId,
      status: status?.status ?? "absent",
    });
    if (!status) return c.json({ error: "No admin task" }, 404);
    return c.json(status, 200);
  });

  // GET /api/admin/github/status — per-user GitHub App install/token check.
  // Takes an explicit userId so the admin can inspect any user; defaults
  // to the caller. Returns non-secret diagnostics only.
  const GithubStatusSchema = z.object({
    githubConnected: z.boolean(),
    githubUsername: z.string().nullable(),
    installationId: z.number().nullable(),
    tokenMinted: z.boolean(),
    tokenPrefix: z.string().nullable(),
    expiresAt: z.string().nullable(),
  });

  const githubStatusRoute = createRoute({
    method: "get",
    path: "/api/admin/github/status",
    tags: ["Admin"],
    summary: "Check a user's GitHub App installation and token minting",
    request: {
      query: z.object({ userId: z.string().optional() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: GithubStatusSchema } },
        description: "GitHub installation status (non-secret diagnostics)",
      },
    },
  });

  router.openapi(githubStatusRoute, async (c) => {
    const { userId } = c.req.valid("query");
    const target = userId ?? c.get("userId");
    const status = await getGithubInstallationStatus(c.env, target);
    return c.json(status, 200);
  });

  return router;
};
