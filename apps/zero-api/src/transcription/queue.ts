import type { Recording, SetTranscriptResult, Transcript } from "@zero/agent-core";

import { fmtErr, log, logError } from "../log";
import type { Transcriber } from "./transcriber";

// The subset of Durable Object storage the queue uses. Values are stored with
// the key-value API, which a SQLite-backed Durable Object caps at 2 MiB each,
// so audio is split into chunks.
export type QueueStorage = {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
};

export type TranscriptionWorkspace = {
  recording(id: string): Promise<Recording | null>;
  recordingDeleted(id: string): boolean;
  listProjects(): { title: string }[];
  setRecordingTranscript(id: string, transcript: Transcript): Promise<SetTranscriptResult>;
};

type Job = { userId: string; chunks: number; attempts: number; notBefore: number; queuedAt: number };

const JOB = "transcription-job:";
const AUDIO = "transcription-audio:";
const CHUNK_BYTES = 1024 * 1024;
const APP_TERMS = ["Zero"];

// Waits before the second, third, ... attempt. One attempt per entry plus the
// first, then the queue gives up and the phone sends the audio again the next
// time the app starts.
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];

// The phone may upload a note before its row has synced here. Its audio waits
// on the retry schedule for the row, and is dropped quietly if it never comes.
class NotSyncedYet extends Error {
  constructor() {
    super("The Recording has not synced to the server yet");
  }
}

const chunkKey = (id: string, index: number) => `${AUDIO}${id}:${index}`;
const chunkKeys = (id: string, chunks: number) => Array.from({ length: chunks }, (_, index) => chunkKey(id, index));

// Holds a Recording's audio in its account's Durable Object until it has a
// transcript, so transcription does not depend on the phone staying connected.
// enqueue() stores the audio and wakes the alarm; runDue() is the alarm body.
export function createTranscriptionQueue({
  storage,
  workspace,
  transcriber,
  onGiveUp,
  now = () => Date.now(),
}: {
  storage: QueueStorage;
  workspace: TranscriptionWorkspace;
  transcriber: Transcriber;
  onGiveUp: (error: unknown, userId: string) => Promise<void>;
  now?: () => number;
}) {
  const transcribe = async (id: string, job: Job) => {
    const recording = await workspace.recording(id);
    if (!recording) {
      if (workspace.recordingDeleted(id)) return;
      throw new NotSyncedYet();
    }
    if (recording.transcript) return;
    const parts = await storage.get<Uint8Array>(chunkKeys(id, job.chunks));
    const audio = new Blob(chunkKeys(id, job.chunks).map((key) => {
      const part = parts.get(key);
      if (!part) throw new Error("Queued audio is incomplete");
      return part;
    }), { type: "audio/mp4" });
    const keywords = [...APP_TERMS, ...workspace.listProjects().map((project) => project.title)];
    const started = now();
    const transcript = await transcriber(audio, { keywords });
    if (await workspace.setRecordingTranscript(id, transcript) !== "set") return;
    log("recording_transcribed", {
      clerk_user_id: job.userId,
      model: transcript.model,
      duration_ms: recording.durationMs,
      latency_ms: now() - started,
      queued_ms: now() - job.queuedAt,
      attempts: job.attempts + 1,
      empty: transcript.text === "",
    });
  };

  const drop = (id: string, job: Job) => storage.delete([`${JOB}${id}`, ...chunkKeys(id, job.chunks)]);

  const wakeAt = async (time: number) => {
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > time) await storage.setAlarm(time);
  };

  return {
    async enqueue(id: string, userId: string, audio: ArrayBuffer): Promise<void> {
      if (!await storage.get<Job>(`${JOB}${id}`)) {
        const bytes = new Uint8Array(audio);
        const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
        const entries: Record<string, unknown> = {};
        for (let index = 0; index < chunks; index++) {
          entries[chunkKey(id, index)] = bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        }
        const time = now();
        entries[`${JOB}${id}`] = { userId, chunks, attempts: 0, notBefore: time, queuedAt: time } satisfies Job;
        await storage.put(entries);
      }
      await wakeAt(now());
    },

    async runDue(): Promise<void> {
      for (const [key, job] of await storage.list<Job>({ prefix: JOB })) {
        if (job.notBefore > now()) continue;
        const id = key.slice(JOB.length);
        try {
          await transcribe(id, job);
          await drop(id, job);
        } catch (error) {
          const notSynced = error instanceof NotSyncedYet;
          const fields = { clerk_user_id: job.userId, attempt: job.attempts + 1 };
          if (notSynced) log("recording_transcription_waiting", fields);
          else logError("recording_transcription_failed", { ...fields, error: fmtErr(error) });
          const delay = RETRY_DELAYS_MS[job.attempts];
          if (delay === undefined) {
            await drop(id, job);
            if (!notSynced) await onGiveUp(error, job.userId);
          } else {
            await storage.put({ [key]: { ...job, attempts: job.attempts + 1, notBefore: now() + delay } satisfies Job });
          }
        }
      }
      const waiting = [...(await storage.list<Job>({ prefix: JOB })).values()];
      if (waiting.length > 0) await storage.setAlarm(Math.min(...waiting.map((job) => job.notBefore)));
    },
  };
}
