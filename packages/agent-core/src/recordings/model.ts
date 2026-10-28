import type { MergeableStore, Row } from "tinybase";

const TABLE = "recordings";

export type RecordingSource = "widget" | "app";

export type Transcript = {
  text: string;
  verbatim: string;
  model: string;
  transcribedAt: string;
};

export type Recording = {
  id: string;
  startedAt: string;
  timeZone: string;
  durationMs: number;
  source: RecordingSource;
  device: string;
  transcript: Transcript | null;
  title: string | null;
};

export type NewRecording = Omit<Recording, "transcript" | "title">;

export type SetTranscriptResult = "set" | "missing" | "exists";

export type SetTitleResult = "set" | "missing" | "exists";

function isTranscript(value: unknown): value is Transcript {
  if (typeof value !== "object" || value === null) return false;
  const { text, verbatim, model, transcribedAt } = value as Record<string, unknown>;
  return typeof text === "string"
    && typeof verbatim === "string"
    && typeof model === "string" && model !== ""
    && typeof transcribedAt === "string" && !Number.isNaN(Date.parse(transcribedAt));
}

function readTranscript(cell: unknown): Transcript | null {
  if (typeof cell !== "string") return null;
  try {
    const value: unknown = JSON.parse(cell);
    if (!isTranscript(value)) return null;
    const { text, verbatim, model, transcribedAt } = value;
    return { text, verbatim, model, transcribedAt };
  } catch {
    return null;
  }
}

function readRecording(id: string, row: Row): Recording | null {
  const { startedAt, timeZone, durationMs, source, device } = row;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (typeof timeZone !== "string" || timeZone === "") return null;
  if (typeof durationMs !== "number" || durationMs < 0) return null;
  if (source !== "widget" && source !== "app") return null;
  if (typeof device !== "string") return null;
  const title = typeof row.title === "string" && row.title.trim() !== "" ? row.title : null;
  return { id, startedAt, timeZone, durationMs, source, device, transcript: readTranscript(row.transcript), title };
}

export type RecordingView<T> = {
  id: string;
  startedAt: string;
  timeZone: string;
  recordedOn: string;
  recordedAt: string;
  durationMs: number;
  device: string;
  title: string | null;
  transcript: "pending" | "no-speech" | T;
};

function localStart({ startedAt, timeZone }: Recording): { recordedOn: string; recordedAt: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(startedAt)).map(({ type, value }) => [type, value]));
  return { recordedOn: `${parts.year}-${parts.month}-${parts.day}`, recordedAt: `${parts.hour}:${parts.minute}` };
}

function view<T>(recording: Recording, detail: (transcript: Transcript) => T): RecordingView<T> {
  const { id, startedAt, timeZone, durationMs, device, title, transcript } = recording;
  return {
    id, startedAt, timeZone, ...localStart(recording), durationMs, device, title,
    transcript: !transcript ? "pending" : transcript.text === "" ? "no-speech" : detail(transcript),
  };
}

export const recordingSummary = (recording: Recording): RecordingView<{ text: string }> =>
  view(recording, ({ text }) => ({ text }));

export const recordingDetail = (recording: Recording): RecordingView<Transcript> =>
  view(recording, ({ text, verbatim, model, transcribedAt }) => ({ text, verbatim, model, transcribedAt }));

export class RecordingModel {
  constructor(private readonly store: MergeableStore) {}

  add(recording: NewRecording): void {
    if (this.store.hasRow(TABLE, recording.id)) throw new Error("Recording id already exists");
    if (!readRecording(recording.id, recording)) throw new Error("Invalid recording");
    const { id, startedAt, timeZone, durationMs, source, device } = recording;
    this.store.setRow(TABLE, id, { startedAt, timeZone, durationMs, source, device });
  }

  get(id: string): Recording | null {
    if (!this.store.hasRow(TABLE, id)) return null;
    return readRecording(id, this.store.getRow(TABLE, id));
  }

  setTranscript(id: string, transcript: Transcript): SetTranscriptResult {
    if (!isTranscript(transcript)) throw new Error("Invalid transcript");
    const recording = this.get(id);
    if (!recording) return "missing";
    if (recording.transcript) return "exists";
    const { text, verbatim, model, transcribedAt } = transcript;
    this.store.setCell(TABLE, id, "transcript", JSON.stringify({ text, verbatim, model, transcribedAt }));
    return "set";
  }

  // Only TaskDO writes a title, once, after the transcript has text.
  setTitle(id: string, title: string): SetTitleResult {
    if (title.trim() === "") throw new Error("Invalid title");
    const recording = this.get(id);
    if (!recording) return "missing";
    if (recording.title) return "exists";
    if (!recording.transcript?.text) throw new Error("Recording has no transcript text");
    this.store.setCell(TABLE, id, "title", title);
    return "set";
  }

  untitled(): Recording[] {
    return this.list().filter((recording) => recording.transcript?.text && !recording.title);
  }

  remove(id: string): void {
    if (this.store.hasRow(TABLE, id)) this.store.delRow(TABLE, id);
  }

  deleted(): string[] {
    const rows = this.store.getMergeableContent()[0][0][TABLE]?.[0] ?? {};
    return Object.entries(rows)
      .filter(([, [cells]]) => Object.values(cells).length > 0 && Object.values(cells).every(([value]) => value == null))
      .map(([id]) => id);
  }

  onDeleted(listener: (id: string) => void): () => void {
    const listenerId = this.store.addRowListener(TABLE, null, (_store, _table, id) => {
      if (this.deleted().includes(id)) listener(id);
    });
    return () => { this.store.delListener(listenerId); };
  }

  list(): Recording[] {
    return this.store.getRowIds(TABLE)
      .flatMap((id) => readRecording(id, this.store.getRow(TABLE, id)) ?? [])
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }
}
