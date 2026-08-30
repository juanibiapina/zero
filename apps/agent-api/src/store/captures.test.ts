import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbCaptureStore } from "./captures";

// A DbCaptureStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's add/list SQL against an in-memory table.
const makeStore = () => new DbCaptureStore(createDb(createMockStorage()));

describe("DbCaptureStore", () => {
  it("stores an added capture under the client id and returns it", () => {
    const store = makeStore();

    const capture = store.add("id-1", "buy milk");

    expect(capture.id).toBe("id-1");
    expect(capture.text).toBe("buy milk");
    expect(store.list()).toEqual([capture]);
  });

  it("lists captures in capture order (oldest first)", () => {
    const store = makeStore();

    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    expect(store.list()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(makeStore().list()).toEqual([]);
  });

  it("adds captures open (processedAt is null)", () => {
    const store = makeStore();

    const capture = store.add("id-1", "open item");

    expect(capture.processedAt).toBeNull();
  });

  it("drops a processed capture from Captures but keeps the others", () => {
    const store = makeStore();
    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    const processed = store.process(first.id);

    expect(processed?.id).toBe(first.id);
    expect(processed?.processedAt).toBeTruthy();
    expect(store.list()).toEqual([second]);
  });

  it("returns null when processing an unknown id", () => {
    const store = makeStore();
    store.add("id-1", "only");

    expect(store.process("nope")).toBeNull();
  });

  it("dedupes a replayed add that re-sends the same id", () => {
    const store = makeStore();

    const first = store.add("id-1", "buy milk");
    // A retried write re-sends the same id; the stored row wins, unchanged.
    const replay = store.add("id-1", "different text");

    expect(replay.id).toBe(first.id);
    expect(replay.text).toBe("buy milk");
    expect(store.list()).toEqual([first]);
  });

  it("treats adds under different ids as independent", () => {
    const store = makeStore();

    const a = store.add("id-1", "a");
    const b = store.add("id-2", "b");

    expect(store.list()).toEqual([a, b]);
  });

  it("edits a capture's text and returns the updated row", () => {
    const store = makeStore();
    const original = store.add("id-1", "buy milk");

    const edited = store.editText("id-1", "buy oat milk");

    expect(edited?.id).toBe("id-1");
    expect(edited?.text).toBe("buy oat milk");
    // Only text changes: createdAt and processedAt are untouched.
    expect(edited?.createdAt).toBe(original.createdAt);
    expect(edited?.processedAt).toBeNull();
  });

  it("keeps list position when editing text", () => {
    const store = makeStore();
    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    store.editText("id-1", "first edited");

    expect(store.list().map((c) => c.id)).toEqual([first.id, second.id]);
    expect(store.list()[0].text).toBe("first edited");
  });

  it("returns null when editing an unknown id", () => {
    const store = makeStore();
    store.add("id-1", "only");

    expect(store.editText("nope", "x")).toBeNull();
  });
});
