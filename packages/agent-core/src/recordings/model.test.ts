import { createMergeableStore, type MergeableContent } from "tinybase";
import { describe, expect, it } from "vitest";

import { RecordingModel, type NewRecording, type Recording, type Transcript } from "./model";

const recording = (overrides: Partial<NewRecording> = {}): NewRecording => ({
  id: "r1",
  startedAt: "2026-10-20T18:30:00.000Z",
  timeZone: "Europe/Berlin",
  durationMs: 42_000,
  source: "widget",
  device: "Pixel 7",
  ...overrides,
});

const listed = (overrides: Partial<Recording> = {}): Recording => ({ ...recording(), transcript: null, title: null, ...overrides });

const transcript: Transcript = {
  text: "Call Ana on Friday.",
  verbatim: "Um, call Ana on Thursday, no, Friday.",
  model: "gpt-transcribe+gpt-6-luna",
  transcribedAt: "2026-10-20T18:31:00.000Z",
};

describe("Transcripts", () => {
  it("adds a transcript to a saved recording once", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    expect(model.setTranscript("r1", transcript)).toBe("set");
    expect(model.setTranscript("r1", { ...transcript, text: "Something else." })).toBe("exists");
    expect(model.list()).toEqual([listed({ transcript })]);
  });

  it("does not create a recording for a transcript of one that is missing or deleted", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    model.remove("r1");
    expect(model.setTranscript("r1", transcript)).toBe("missing");
    expect(model.setTranscript("other", transcript)).toBe("missing");
    expect(model.list()).toEqual([]);
    expect(model.deleted()).toEqual(["r1"]);
  });

  it("refuses an invalid transcript", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    expect(() => model.setTranscript("r1", { ...transcript, model: "" })).toThrow("Invalid transcript");
    expect(model.get("r1")).toEqual(listed());
  });

  it("reads a malformed transcript cell as no transcript", () => {
    const store = createMergeableStore();
    const model = new RecordingModel(store);
    model.add(recording());
    store.setCell("recordings", "r1", "transcript", "{not json");
    expect(model.get("r1")).toEqual(listed());
    expect(model.setTranscript("r1", transcript)).toBe("set");
  });

  it("brings the transcript to the phone that recorded it", () => {
    const phone = createMergeableStore();
    const server = createMergeableStore();
    new RecordingModel(phone).add(recording());
    server.merge(phone);
    new RecordingModel(server).setTranscript("r1", transcript);
    phone.merge(server);
    expect(new RecordingModel(phone).list()).toEqual([listed({ transcript })]);
  });

  it("removes the transcript with its recording on every device", () => {
    const phone = createMergeableStore();
    const tablet = createMergeableStore();
    new RecordingModel(phone).add(recording());
    new RecordingModel(phone).setTranscript("r1", transcript);
    tablet.merge(phone);
    new RecordingModel(tablet).remove("r1");
    phone.merge(tablet);
    expect(new RecordingModel(phone).list()).toEqual([]);
    expect(new RecordingModel(phone).deleted()).toEqual(["r1"]);
  });
});

describe("Titles", () => {
  it("adds a title to a transcribed recording once", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    model.setTranscript("r1", transcript);
    expect(model.setTitle("r1", "Call Ana on Friday")).toBe("set");
    expect(model.setTitle("r1", "Something else")).toBe("exists");
    expect(model.list()).toEqual([listed({ transcript, title: "Call Ana on Friday" })]);
  });

  it("does not create a recording for a title of one that is missing or deleted", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    model.remove("r1");
    expect(model.setTitle("r1", "Call Ana")).toBe("missing");
    expect(model.list()).toEqual([]);
  });

  it("refuses an empty, padded, multiline or overlong title", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    for (const title of ["", " Call Ana", "Call\nAna", "x".repeat(81)]) {
      expect(() => model.setTitle("r1", title)).toThrow("Invalid title");
    }
    expect(model.get("r1")).toEqual(listed());
  });

  it("reads a malformed title cell as no title", () => {
    const store = createMergeableStore();
    const model = new RecordingModel(store);
    model.add(recording());
    store.setCell("recordings", "r1", "title", 42);
    expect(model.get("r1")).toEqual(listed());
  });

  it("brings the title to every device", () => {
    const phone = createMergeableStore();
    const server = createMergeableStore();
    new RecordingModel(phone).add(recording());
    server.merge(phone);
    new RecordingModel(server).setTitle("r1", "Call Ana");
    phone.merge(server);
    expect(new RecordingModel(phone).get("r1")?.title).toBe("Call Ana");
  });
});

describe("Recordings", () => {
  it("lists an added recording with every captured fact", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    expect(model.list()).toEqual([listed()]);
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
    expect(model.list()).toEqual([listed()]);
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

  it("removes a recording and remembers it was deleted", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording({ id: "a" }));
    model.add(recording({ id: "b" }));
    model.remove("a");
    expect(model.list().map(({ id }) => id)).toEqual(["b"]);
    expect(model.deleted()).toEqual(["a"]);
  });

  it("remembers a deletion after the workspace is saved and loaded again", () => {
    const store = createMergeableStore();
    new RecordingModel(store).add(recording());
    new RecordingModel(store).remove("r1");
    const reopened = createMergeableStore();
    reopened.setMergeableContent(JSON.parse(JSON.stringify(store.getMergeableContent())) as MergeableContent);
    expect(new RecordingModel(reopened).deleted()).toEqual(["r1"]);
  });

  it("ignores removing a recording that is not there", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    model.remove("missing");
    expect(model.list()).toEqual([listed()]);
    expect(model.deleted()).toEqual([]);
  });

  it("tells the phone holding the audio when another phone deletes the recording", () => {
    const phone = createMergeableStore();
    const tablet = createMergeableStore();
    new RecordingModel(phone).add(recording());
    tablet.merge(phone);
    const heard: string[] = [];
    new RecordingModel(phone).onDeleted((id) => heard.push(id));
    new RecordingModel(tablet).remove("r1");
    phone.merge(tablet);
    expect(heard).toEqual(["r1"]);
    expect(new RecordingModel(phone).list()).toEqual([]);
    expect(new RecordingModel(phone).deleted()).toEqual(["r1"]);
  });

  it("tells about a deletion made on the same phone", () => {
    const model = new RecordingModel(createMergeableStore());
    model.add(recording());
    const heard: string[] = [];
    const stop = model.onDeleted((id) => heard.push(id));
    model.remove("r1");
    stop();
    expect(heard).toEqual(["r1"]);
  });

  it("does not count a recording dropped by reloading older content as deleted", () => {
    const store = createMergeableStore();
    const model = new RecordingModel(store);
    model.add(recording());
    const heard: string[] = [];
    model.onDeleted((id) => heard.push(id));
    store.setMergeableContent(createMergeableStore().getMergeableContent());
    expect(model.list()).toEqual([]);
    expect(heard).toEqual([]);
    expect(model.deleted()).toEqual([]);
  });
});
