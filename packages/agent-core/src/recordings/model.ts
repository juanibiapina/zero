import type { MergeableStore, Row } from "tinybase";

const TABLE = "recordings";

export type RecordingSource = "widget" | "app";

export type Recording = {
  id: string;
  startedAt: string;
  timeZone: string;
  durationMs: number;
  source: RecordingSource;
  device: string;
};

function readRecording(id: string, row: Row): Recording | null {
  const { startedAt, timeZone, durationMs, source, device } = row;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (typeof timeZone !== "string" || timeZone === "") return null;
  if (typeof durationMs !== "number" || durationMs < 0) return null;
  if (source !== "widget" && source !== "app") return null;
  if (typeof device !== "string") return null;
  return { id, startedAt, timeZone, durationMs, source, device };
}

export class RecordingModel {
  constructor(private readonly store: MergeableStore) {}

  add(recording: Recording): void {
    if (this.store.hasRow(TABLE, recording.id)) throw new Error("Recording id already exists");
    if (!readRecording(recording.id, recording)) throw new Error("Invalid recording");
    const { id, ...cells } = recording;
    this.store.setRow(TABLE, id, cells);
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
