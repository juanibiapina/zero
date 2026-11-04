import { OpenAPIHono } from "@hono/zod-openapi";
import type { Recording, Transcript } from "@zero/agent-core";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../types";
import { createRecordingsRoutes, MAX_AUDIO_BYTES } from "./recordings";
import { taskDoEnv } from "./taskdo-test-stub";

const recording: Recording = {
  id: "r1",
  startedAt: "2026-10-20T18:30:00.000Z",
  timeZone: "Europe/Berlin",
  durationMs: 20_000,
  source: "app",
  device: "Pixel 7",
  transcript: null,
  handledAt: null,
};

const transcript: Transcript = {
  text: "Call Ana on Friday.",
  verbatim: "Um, call Ana on Thursday, no, Friday.",
  title: "Call Ana on Friday",
  model: "stt+cleanup",
  transcribedAt: "2026-10-20T18:31:00.000Z",
};

function buildApp(methods: object) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createRecordingsRoutes());
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), env);
}

const upload = (audio: Blob | null = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" })): RequestInit => {
  const form = new FormData();
  if (audio) form.append("audio", audio, "r1.m4a");
  return { method: "POST", body: form };
};

describe("recording transcript route", () => {
  it("hands the audio to the account's TaskDO and answers before transcribing", async () => {
    const queueTranscription = vi.fn(async () => {});
    const app = buildApp({ recording: async () => recording, queueTranscription });

    const response = await app("/api/recordings/r1/transcript", upload());

    expect(response.status).toBe(202);
    expect(queueTranscription).toHaveBeenCalledWith("r1", "user-abc", expect.any(ArrayBuffer));
    expect([...new Uint8Array((queueTranscription.mock.calls[0] as unknown[])[2] as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("returns a stored transcript without queueing the audio", async () => {
    const queueTranscription = vi.fn();
    const app = buildApp({ recording: async () => ({ ...recording, transcript }), queueTranscription });

    const response = await app("/api/recordings/r1/transcript", upload());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript });
    expect(queueTranscription).not.toHaveBeenCalled();
  });

  it("queues the audio of a Recording whose row has not synced yet", async () => {
    const queueTranscription = vi.fn(async () => {});
    const app = buildApp({ recording: async () => null, queueTranscription });

    expect((await app("/api/recordings/r1/transcript", upload())).status).toBe(202);
    expect(queueTranscription).toHaveBeenCalledWith("r1", "user-abc", expect.any(ArrayBuffer));
  });

  it("refuses a request with no audio or audio over 25 MB", async () => {
    const queueTranscription = vi.fn();
    const app = buildApp({ recording: async () => recording, queueTranscription });

    expect((await app("/api/recordings/r1/transcript", upload(null))).status).toBe(400);
    expect((await app("/api/recordings/r1/transcript", upload(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)])))).status).toBe(413);
    expect(queueTranscription).not.toHaveBeenCalled();
  });
});
