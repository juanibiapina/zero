/**
 * ============================================================================
 * agent-server contract
 * ============================================================================
 *
 * The HTTP shape of the agent-server, defined once. Both the server (which
 * mounts these routes on an OpenAPIHono app) and the worker-side client
 * (which derives a typed `hc` client from the app's TS type) refer back to
 * this file for schemas; the URL grammar and method names live entirely
 * in the route definitions below and are never restated by hand.
 *
 * Pure data — no Node, Cloudflare, or filesystem imports. Importable from
 * anywhere.
 */

import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────

export const SessionCreatedSchema = z.object({
  sessionId: z.string().min(1),
});

export const SendMessageParamsSchema = z.object({
  sessionId: z.string().min(1),
});

export const SendMessageBodySchema = z.object({
  text: z.string().min(1),
});

export const ErrorSchema = z.object({
  error: z.string(),
});

// ── Routes ──────────────────────────────────────────────────────────────

export const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  summary: "Create a new session",
  responses: {
    200: {
      content: { "application/json": { schema: SessionCreatedSchema } },
      description: "Session created",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Failed to create session",
    },
  },
});

export const sendMessageRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/messages",
  summary: "Post a message to an existing session",
  request: {
    params: SendMessageParamsSchema,
    body: {
      content: { "application/json": { schema: SendMessageBodySchema } },
    },
  },
  responses: {
    202: {
      description: "Message accepted; reply will arrive out of band via REPLY_URL",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Unknown sessionId (container has no on-disk state for it)",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Unhandled server error (handler threw, framework error, etc.)",
    },
  },
});
