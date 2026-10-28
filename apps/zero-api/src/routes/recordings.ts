import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Transcript } from "@zero/agent-core";
import { z } from "zod";

import { fmtErr, log, logError } from "../log";
import { getTaskDO } from "../TaskDO/stub";
import { openaiCleanup, openaiSpeechToText, openaiTitleWriter } from "../transcription/openai";
import { createTitler, type Titler } from "../transcription/title";
import { createTranscriber, type Transcriber } from "../transcription/transcriber";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const APP_TERMS = ["Zero"];

export type MakeTranscriber = (env: Env) => Transcriber;
export type MakeTitler = (env: Env) => Titler;

const defaultTranscriber: MakeTranscriber = (env) => createTranscriber({
  speechToText: openaiSpeechToText({ apiKey: env.OPENAI_API_KEY }),
  cleanup: openaiCleanup({ apiKey: env.OPENAI_API_KEY }),
});

const defaultTitler: MakeTitler = (env) => createTitler(openaiTitleWriter({ apiKey: env.OPENAI_API_KEY }));

const TranscriptSchema = z.object({
  text: z.string(),
  verbatim: z.string(),
  model: z.string(),
  transcribedAt: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });

export const createRecordingsRoutes = (deps: { transcriber?: MakeTranscriber; titler?: MakeTitler } = {}) => {
  const makeTranscriber = deps.transcriber ?? defaultTranscriber;
  const makeTitler = deps.titler ?? defaultTitler;
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // A title is a convenience on top of the transcript. It is written in the
  // background after the response, once, with no retry: when it cannot be
  // written, the Recording keeps its transcript and stays untitled.
  const giveTitle = async (env: Env, userId: string, id: string, text: string) => {
    if (text === "") return;
    try {
      const title = await makeTitler(env)(text);
      if (!title) {
        log("recording_title_skipped", { clerk_user_id: userId });
        return;
      }
      await getTaskDO(env, userId).setRecordingTitle(id, title);
    } catch (error) {
      logError("recording_title_failed", { clerk_user_id: userId, error: fmtErr(error) });
    }
  };

  const transcribeRoute = createRoute({
    method: "post",
    path: "/api/recordings/{id}/transcript",
    tags: ["Recordings"],
    summary: "Transcribe a Recording from its audio, once, and give it a title",
    request: {
      params: z.object({ id: z.string().min(1) }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ transcript: TranscriptSchema }) } },
        description: "The Recording's transcript, new or already stored",
      },
      400: { content: { "application/json": { schema: ErrorSchema } }, description: "No audio file in the form" },
      404: { content: { "application/json": { schema: ErrorSchema } }, description: "No such Recording on the server yet" },
      413: { content: { "application/json": { schema: ErrorSchema } }, description: "Audio larger than 25 MB" },
      502: { content: { "application/json": { schema: ErrorSchema } }, description: "Transcription failed; try again later" },
    },
  });

  router.openapi(transcribeRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > MAX_AUDIO_BYTES + 64 * 1024) return c.json({ error: "audio is larger than 25 MB" }, 413);

    const taskDO = getTaskDO(c.env, userId);
    const recording = await taskDO.recording(id);
    if (!recording) return c.json({ error: "recording not found" }, 404);
    if (recording.transcript) return c.json({ transcript: recording.transcript }, 200);

    const audio = await c.req.formData().then((form) => form.get("audio")).catch(() => null);
    if (!(audio instanceof Blob) || audio.size === 0) return c.json({ error: "missing audio file" }, 400);
    if (audio.size > MAX_AUDIO_BYTES) return c.json({ error: "audio is larger than 25 MB" }, 413);

    const keywords = [...APP_TERMS, ...(await taskDO.listProjects()).map((project) => project.title)];
    const started = Date.now();
    let transcript: Transcript;
    try {
      transcript = await makeTranscriber(c.env)(audio, { keywords });
    } catch (error) {
      logError("recording_transcription_failed", { clerk_user_id: userId, error: fmtErr(error) });
      return c.json({ error: "transcription failed" }, 502);
    }

    const result = await taskDO.setRecordingTranscript(id, transcript);
    if (result === "missing") return c.json({ error: "recording not found" }, 404);
    log("recording_transcribed", {
      clerk_user_id: userId,
      model: transcript.model,
      duration_ms: recording.durationMs,
      latency_ms: Date.now() - started,
      empty: transcript.text === "",
    });
    if (result === "set") c.executionCtx.waitUntil(giveTitle(c.env, userId, id, transcript.text));
    if (result === "exists") {
      const stored = (await taskDO.recording(id))?.transcript;
      if (stored) return c.json({ transcript: stored }, 200);
    }
    return c.json({ transcript }, 200);
  });

  return router;
};
