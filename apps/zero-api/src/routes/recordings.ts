import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { getTaskDO } from "../TaskDO/stub";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const TranscriptSchema = z.object({
  text: z.string(),
  verbatim: z.string(),
  title: z.string(),
  model: z.string(),
  transcribedAt: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });

export const createRecordingsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const transcribeRoute = createRoute({
    method: "post",
    path: "/api/recordings/{id}/transcript",
    tags: ["Recordings"],
    summary: "Send a Recording's audio for its transcript, once",
    request: {
      params: z.object({ id: z.string().min(1) }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ transcript: TranscriptSchema }) } },
        description: "The Recording's stored transcript",
      },
      202: {
        content: { "application/json": { schema: z.object({ queued: z.literal(true) }) } },
        description: "The audio is stored; the transcript syncs to the Recording when it is ready",
      },
      400: { content: { "application/json": { schema: ErrorSchema } }, description: "No audio file in the form" },
      413: { content: { "application/json": { schema: ErrorSchema } }, description: "Audio larger than 25 MB" },
    },
  });

  router.openapi(transcribeRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > MAX_AUDIO_BYTES + 64 * 1024) return c.json({ error: "audio is larger than 25 MB" }, 413);

    const taskDO = getTaskDO(c.env, userId);
    // The Recording's row may not have synced yet; the queue waits for it.
    const recording = await taskDO.recording(id);
    if (recording?.transcript) return c.json({ transcript: recording.transcript }, 200);

    const audio = await c.req.formData().then((form) => form.get("audio")).catch(() => null);
    if (!(audio instanceof Blob) || audio.size === 0) return c.json({ error: "missing audio file" }, 400);
    if (audio.size > MAX_AUDIO_BYTES) return c.json({ error: "audio is larger than 25 MB" }, 413);

    await taskDO.queueTranscription(id, userId, await audio.arrayBuffer());
    return c.json({ queued: true as const }, 202);
  });

  return router;
};
