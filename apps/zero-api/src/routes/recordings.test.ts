import { OpenAPIHono } from "@hono/zod-openapi";
import type { Recording, Transcript } from "@zero/agent-core";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../types";
import type { Transcriber } from "../transcription/transcriber";
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
};

const transcript: Transcript = {
  text: "Call Ana on Friday.",
  verbatim: "Um, call Ana on Thursday, no, Friday.",
  model: "stt+cleanup",
  transcribedAt: "2026-10-20T18:31:00.000Z",
};

function buildApp(methods: object, transcriber: Transcriber) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createRecordingsRoutes({ transcriber: () => transcriber }));
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), env);
}

const upload = (audio: Blob | null = new Blob([new Uint8Array(1000)], { type: "audio/mp4" })): RequestInit => {
  const form = new FormData();
  if (audio) form.append("audio", audio, "r1.m4a");
  return { method: "POST", body: form };
};

describe("recording transcript route", () => {
  it("transcribes the audio with the workspace's Project names and stores the transcript", async () => {
    const transcriber = vi.fn<Transcriber>(async () => transcript);
    const setRecordingTranscript = vi.fn(async () => "set");
    const app = buildApp({
      recording: async () => recording,
      listProjects: async () => [{ title: "Boiler repair" }, { title: "ZeroVault" }],
      setRecordingTranscript,
    }, transcriber);

    const response = await app("/api/recordings/r1/transcript", upload());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript });
    expect(transcriber).toHaveBeenCalledWith(expect.any(Blob), { keywords: ["Zero", "Boiler repair", "ZeroVault"] });
    expect(setRecordingTranscript).toHaveBeenCalledWith("r1", transcript);
  });

  it("returns a stored transcript without transcribing again", async () => {
    const transcriber = vi.fn<Transcriber>();
    const app = buildApp({ recording: async () => ({ ...recording, transcript }) }, transcriber);

    const response = await app("/api/recordings/r1/transcript", upload());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript });
    expect(transcriber).not.toHaveBeenCalled();
  });

  it("answers 404 for a Recording the server does not have yet", async () => {
    const transcriber = vi.fn<Transcriber>();
    const app = buildApp({ recording: async () => null }, transcriber);

    expect((await app("/api/recordings/r1/transcript", upload())).status).toBe(404);
    expect(transcriber).not.toHaveBeenCalled();
  });

  it("answers 404 when the Recording is deleted while it is being transcribed", async () => {
    const app = buildApp({
      recording: async () => recording,
      listProjects: async () => [],
      setRecordingTranscript: async () => "missing",
    }, async () => transcript);

    expect((await app("/api/recordings/r1/transcript", upload())).status).toBe(404);
  });

  it("keeps the first transcript when two uploads race", async () => {
    const first = { ...transcript, text: "First." };
    let stored: Transcript | null = null;
    const app = buildApp({
      recording: async () => ({ ...recording, transcript: stored }),
      listProjects: async () => [],
      setRecordingTranscript: async () => { stored = first; return "exists"; },
    }, async () => transcript);

    const response = await app("/api/recordings/r1/transcript", upload());

    expect(await response.json()).toEqual({ transcript: first });
  });

  it("refuses a request with no audio or audio over 25 MB", async () => {
    const transcriber = vi.fn<Transcriber>();
    const app = buildApp({ recording: async () => recording }, transcriber);

    expect((await app("/api/recordings/r1/transcript", upload(null))).status).toBe(400);
    expect((await app("/api/recordings/r1/transcript", upload(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)])))).status).toBe(413);
    expect(transcriber).not.toHaveBeenCalled();
  });

  it("answers 502 and stores nothing when transcription fails", async () => {
    const setRecordingTranscript = vi.fn();
    const app = buildApp({
      recording: async () => recording,
      listProjects: async () => [],
      setRecordingTranscript,
    }, async () => { throw new Error("provider down"); });

    expect((await app("/api/recordings/r1/transcript", upload())).status).toBe(502);
    expect(setRecordingTranscript).not.toHaveBeenCalled();
  });
});
