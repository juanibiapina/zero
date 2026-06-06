// The HTTP shape of the agent-server, defined once and consumed by both
// `app.ts` (server) and the worker's `agent-client.ts` (client). Pure
// data — no Node, Cloudflare, or filesystem imports.

import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";

export const SessionCreatedSchema = z.object({
  sessionId: z.string().min(1),
});

export const SessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

/** @deprecated Use SessionParamsSchema */
export const SendMessageParamsSchema = SessionParamsSchema;

export const AttachmentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
});

export const SendMessageBodySchema = z
  .object({
    text: z.string().default(""),
    attachments: z.array(AttachmentSchema).optional(),
  })
  .refine(
    (b) => b.text.length > 0 || (b.attachments?.length ?? 0) > 0,
    { message: "text or attachments required" },
  );

export const ErrorSchema = z.object({
  error: z.string(),
});

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

export const abortSessionRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/abort",
  summary: "Abort a running prompt",
  request: {
    params: SessionParamsSchema,
  },
  responses: {
    204: {
      description: "Aborted successfully",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Unknown sessionId",
    },
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Nothing running to abort",
    },
  },
});

export const SessionStatusSchema = z.object({
  model: z.string(),
  contextPercent: z.number().nullable(),
});

export const ImportNotesBodySchema = z.object({
  dataBase64: z.string().min(1),
});

export const ImportNotesResultSchema = z.object({
  filesExtracted: z.number(),
});

export const getSessionStatusRoute = createRoute({
  method: "get",
  path: "/sessions/{sessionId}/status",
  summary: "Get session status (model, context usage)",
  request: {
    params: SessionParamsSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SessionStatusSchema } },
      description: "Session status",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Unknown sessionId",
    },
  },
});

export const importNotesRoute = createRoute({
  method: "post",
  path: "/import-notes",
  summary: "Import notes from a zip archive",
  request: {
    body: {
      content: { "application/json": { schema: ImportNotesBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportNotesResultSchema } },
      description: "Notes imported successfully",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Import failed",
    },
  },
});
