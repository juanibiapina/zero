// Clerk-authed routes backing the web chat client.
//
// A WebUI session is a container session (same machinery as Telegram)
// recorded in the UserDO with type="webui". The unified `messages` table
// is the browser's display source; the browser polls
// GET /api/sessions/{sessionId}/messages?since=<cursor> for new rows.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createAgentClient } from "../agent-client";
import { log, logError } from "../log";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

const ErrorSchema = z.object({ error: z.string() });

const SessionSchema = z.object({
  sessionId: z.string(),
  type: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  updatedAt: z.string().nullable(),
});

const MessageSchema = z.object({
  id: z.number(),
  role: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

export const createSessionRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── Create a session ────────────────────────────────────────────
  const createSessionRoute = createRoute({
    method: "post",
    path: "/api/sessions",
    tags: ["Sessions"],
    summary: "Create a WebUI chat session",
    request: {
      body: {
        content: { "application/json": { schema: z.object({ name: z.string().min(1).optional() }) } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ sessionId: z.string() }) } },
        description: "Session created",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Failed to create session",
      },
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { name } = c.req.valid("json");
    const agent = createAgentClient(c.env, clerkUserId);
    const userDO = getUserDO(c.env, clerkUserId);

    const result = await agent.createSession();
    if (result.kind === "error") {
      logError("webui_create_session_failed", { clerk_user_id: clerkUserId, status: result.status });
      return c.json({ error: "failed to create session" }, 500);
    }

    await userDO.createWebuiSession(result.sessionId, name);
    log("webui_session_created", { session_id: result.sessionId, clerk_user_id: clerkUserId });
    return c.json({ sessionId: result.sessionId }, 200);
  });

  // ── List sessions ───────────────────────────────────────────────
  const listSessionsRoute = createRoute({
    method: "get",
    path: "/api/sessions",
    tags: ["Sessions"],
    summary: "List the caller's sessions",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ sessions: z.array(SessionSchema) }) } },
        description: "Sessions",
      },
    },
  });

  router.openapi(listSessionsRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const userDO = getUserDO(c.env, clerkUserId);
    const rows = await userDO.listSessions();
    const sessions = rows.map((s) => ({
      sessionId: s.sessionId,
      type: s.type,
      name: s.name,
      status: s.status,
      updatedAt: s.updatedAt,
    }));
    return c.json({ sessions }, 200);
  });

  // ── Send a message ──────────────────────────────────────────────
  const sendMessageRoute = createRoute({
    method: "post",
    path: "/api/sessions/{sessionId}/messages",
    tags: ["Sessions"],
    summary: "Send a message to a session",
    request: {
      params: z.object({ sessionId: z.string() }),
      body: {
        content: { "application/json": { schema: z.object({ text: z.string().min(1) }) } },
      },
    },
    responses: {
      202: {
        content: { "application/json": { schema: z.object({ sessionId: z.string() }) } },
        description: "Message accepted",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unknown session",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Failed to send message",
      },
    },
  });

  router.openapi(sendMessageRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { sessionId } = c.req.valid("param");
    const { text } = c.req.valid("json");
    const agent = createAgentClient(c.env, clerkUserId);
    const userDO = getUserDO(c.env, clerkUserId);

    const record = await userDO.lookupSessionById(sessionId);
    if (!record || record.type !== "webui") {
      return c.json({ error: "unknown session" }, 404);
    }

    await userDO.appendMessage(sessionId, "user", text);
    let result = await agent.sendMessage(sessionId, text);

    let activeSessionId = sessionId;
    if (result.kind === "stale") {
      // Rare: container lost the session (R2 data loss). Mint a fresh one
      // and tell the client to navigate to it.
      log("webui_stale_session", { session_id: sessionId, clerk_user_id: clerkUserId });
      await userDO.forgetSession(sessionId);
      const created = await agent.createSession();
      if (created.kind === "error") {
        logError("webui_create_session_failed", { clerk_user_id: clerkUserId, status: created.status });
        return c.json({ error: "failed to create session" }, 500);
      }
      await userDO.createWebuiSession(created.sessionId, record.name);
      activeSessionId = created.sessionId;
      await userDO.appendMessage(activeSessionId, "user", text);
      result = await agent.sendMessage(activeSessionId, text);
    }

    if (result.kind === "error") {
      logError("webui_send_failed", { clerk_user_id: clerkUserId, session_id: activeSessionId, status: result.status });
      return c.json({ error: "failed to send message" }, 500);
    }

    await userDO.markSessionActiveById(activeSessionId);
    log("webui_message_forwarded", { clerk_user_id: clerkUserId, session_id: activeSessionId });
    return c.json({ sessionId: activeSessionId }, 202);
  });

  // ── Poll messages ───────────────────────────────────────────────
  const listMessagesRoute = createRoute({
    method: "get",
    path: "/api/sessions/{sessionId}/messages",
    tags: ["Sessions"],
    summary: "List messages for a session",
    request: {
      params: z.object({ sessionId: z.string() }),
      query: z.object({ since: z.coerce.number().optional() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ messages: z.array(MessageSchema), status: z.string().nullable() }),
          },
        },
        description: "Messages",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unknown session",
      },
    },
  });

  router.openapi(listMessagesRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { sessionId } = c.req.valid("param");
    const { since } = c.req.valid("query");
    const userDO = getUserDO(c.env, clerkUserId);

    const record = await userDO.lookupSessionById(sessionId);
    if (!record) {
      return c.json({ error: "unknown session" }, 404);
    }

    const result = await userDO.listMessages(sessionId, since);
    const messages = result.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
    }));
    return c.json({ messages, status: result.status }, 200);
  });

  return router;
};
