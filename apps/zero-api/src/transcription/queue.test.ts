import type { Recording, Transcript } from "@zero/agent-core";
import { describe, expect, it, vi } from "vitest";

import { createTranscriptionQueue, RETRY_DELAYS_MS, type QueueStorage } from "./queue";
import type { Transcriber } from "./transcriber";

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

function memoryStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get(key: string | string[]) {
      if (typeof key === "string") return data.get(key);
      return new Map(key.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async put(entries: Record<string, unknown>) {
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
    async delete(keys: string[]) {
      return keys.filter((key) => data.delete(key)).length;
    },
    async list(options: { prefix: string }) {
      return new Map([...data].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b)));
    },
    async getAlarm() { return alarm; },
    async setAlarm(time: number) { alarm = time; },
  } as unknown as QueueStorage;
  return { storage, data, alarm: () => alarm };
}

function setup({ stored = recording, deleted = false, transcriber = vi.fn<Transcriber>(async () => transcript) }: {
  stored?: Recording | null;
  deleted?: boolean;
  transcriber?: ReturnType<typeof vi.fn<Transcriber>>;
} = {}) {
  let clock = 1_000_000;
  const memory = memoryStorage();
  let current = stored;
  const setRecordingTranscript = vi.fn(async (_id: string, value: Transcript) => {
    if (!current) return "missing" as const;
    current = { ...current, transcript: value };
    return "set" as const;
  });
  const onGiveUp = vi.fn(async () => {});
  const queue = createTranscriptionQueue({
    storage: memory.storage,
    workspace: {
      recording: async () => current,
      recordingDeleted: () => deleted,
      listProjects: () => [{ title: "Boiler repair" }],
      setRecordingTranscript,
    },
    transcriber,
    onGiveUp,
    now: () => clock,
  });
  return {
    queue,
    memory,
    transcriber,
    setRecordingTranscript,
    onGiveUp,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    sync: (row: Recording) => { current = row; },
  };
}

const audio = (bytes: number) => Uint8Array.from({ length: bytes }, (_, index) => index % 251).buffer;

describe("transcription queue", () => {
  it("wakes the alarm, transcribes the stored audio with the Project names, and then forgets the audio", async () => {
    const queued = audio(2.5 * 1024 * 1024);
    const t = setup();

    await t.queue.enqueue("r1", "user-abc", queued);
    expect(t.memory.alarm()).toBe(t.now());

    await t.queue.runDue();

    expect(t.transcriber).toHaveBeenCalledWith(expect.any(Blob), { keywords: ["Zero", "Boiler repair"] });
    const sent = t.transcriber.mock.calls[0][0];
    const [got, want] = [new Uint8Array(await sent.arrayBuffer()), new Uint8Array(queued)];
    expect(got.length === want.length && got.every((byte, index) => byte === want[index])).toBe(true);
    expect(t.setRecordingTranscript).toHaveBeenCalledWith("r1", transcript);
    expect(t.memory.data.size).toBe(0);
  });

  it("keeps one copy when the phone sends the same note twice", async () => {
    const t = setup();

    await t.queue.enqueue("r1", "user-abc", audio(10));
    await t.queue.enqueue("r1", "user-abc", audio(10));
    await t.queue.runDue();

    expect(t.transcriber).toHaveBeenCalledTimes(1);
  });

  it("forgets the audio of a note that was deleted or transcribed meanwhile", async () => {
    const deleted = setup({ stored: null, deleted: true });
    await deleted.queue.enqueue("r1", "user-abc", audio(10));
    await deleted.queue.runDue();

    const done = setup({ stored: { ...recording, transcript } });
    await done.queue.enqueue("r1", "user-abc", audio(10));
    await done.queue.runDue();

    for (const t of [deleted, done]) {
      expect(t.transcriber).not.toHaveBeenCalled();
      expect(t.memory.data.size).toBe(0);
    }
  });

  it("waits for a note whose row has not synced yet", async () => {
    const t = setup({ stored: null });
    await t.queue.enqueue("r1", "user-abc", audio(10));

    await t.queue.runDue();
    expect(t.transcriber).not.toHaveBeenCalled();
    expect(t.memory.alarm()).toBe(t.now() + RETRY_DELAYS_MS[0]);

    t.sync(recording);
    t.advance(RETRY_DELAYS_MS[0]);
    await t.queue.runDue();

    expect(t.setRecordingTranscript).toHaveBeenCalledWith("r1", transcript);
    expect(t.memory.data.size).toBe(0);
  });

  it("drops the audio without reporting when the row never arrives", async () => {
    const t = setup({ stored: null });
    await t.queue.enqueue("r1", "user-abc", audio(10));

    await t.queue.runDue();
    for (const delay of RETRY_DELAYS_MS) {
      t.advance(delay);
      await t.queue.runDue();
    }

    expect(t.transcriber).not.toHaveBeenCalled();
    expect(t.onGiveUp).not.toHaveBeenCalled();
    expect(t.memory.data.size).toBe(0);
  });

  it("retries a failed transcription later from the alarm", async () => {
    const transcriber = vi.fn<Transcriber>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(transcript);
    const t = setup({ transcriber });
    await t.queue.enqueue("r1", "user-abc", audio(10));

    await t.queue.runDue();
    expect(t.memory.alarm()).toBe(t.now() + RETRY_DELAYS_MS[0]);
    await t.queue.runDue();
    expect(transcriber).toHaveBeenCalledTimes(1);

    t.advance(RETRY_DELAYS_MS[0]);
    await t.queue.runDue();

    expect(t.setRecordingTranscript).toHaveBeenCalledWith("r1", transcript);
    expect(t.memory.data.size).toBe(0);
    expect(t.onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up and reports once every retry has failed", async () => {
    const t = setup({ transcriber: vi.fn<Transcriber>(async () => { throw new Error("provider down"); }) });
    await t.queue.enqueue("r1", "user-abc", audio(10));

    await t.queue.runDue();
    for (const delay of RETRY_DELAYS_MS) {
      t.advance(delay);
      await t.queue.runDue();
    }

    expect(t.transcriber).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(t.onGiveUp).toHaveBeenCalledTimes(1);
    expect(t.onGiveUp).toHaveBeenCalledWith(expect.any(Error), "user-abc");
    expect(t.memory.data.size).toBe(0);
  });
});
