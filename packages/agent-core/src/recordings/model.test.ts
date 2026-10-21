import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { RecordingModel, type Recording } from "./model";

const recording = (overrides: Partial<Recording> = {}): Recording => ({
  id: "r1",
  startedAt: "2026-10-20T18:30:00.000Z",
  timeZone: "Europe/Berlin",
  durationMs: 42_000,
  source: "widget",
  device: "Pixel 7",
  ...overrides,
});

describe("Recordings", () => {
  it("lists an added recording with every captured fact", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    expect(model.list()).toEqual([recording()]);
  });

  it("lists the newest recording first", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording({ id: "old", startedAt: "2026-10-19T08:00:00.000Z" }));
    model.add(recording({ id: "new", startedAt: "2026-10-20T08:00:00.000Z" }));
    expect(model.list().map(({ id }) => id)).toEqual(["new", "old"]);
  });

  it("never changes a recording once it is saved", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    expect(() => model.add(recording({ durationMs: 1 }))).toThrow("Recording id already exists");
    expect(model.list()).toEqual([recording()]);
  });

  it("refuses a recording with missing facts", () => {
    const model = new RecordingModel(createMergeableStore());
    expect(() => model.add(recording({ timeZone: "" }))).toThrow("Invalid recording");
    expect(model.list()).toEqual([]);
  });

  it("skips malformed rows from another device", () => {
    const store = createMergeableStore();
    store.setRow("recordings", "bad", { startedAt: "yesterday", durationMs: 1 });
    const model = new RecordingModel(store);
    model.add(recording());
    expect(model.list().map(({ id }) => id)).toEqual(["r1"]);
  });

  it("keeps recordings from two phones after they sync", () => {
    const phone = createMergeableStore();
    const tablet = createMergeableStore();
    new RecordingModel(phone).add(recording({ id: "a" }));
    new RecordingModel(tablet).add(recording({ id: "b", device: "Pixel Tablet" }));
    phone.merge(tablet);
    expect(new RecordingModel(phone).list().map(({ id }) => id).sort()).toEqual(["a", "b"]);
  });
});
