import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbCaptureStore } from "./captures";

// A DbCaptureStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's add/list SQL against an in-memory table.
const makeStore = () => new DbCaptureStore(createDb(createMockStorage()));

describe("DbCaptureStore", () => {
  it("stores an added capture and returns it with an id", () => {
    const store = makeStore();

    const capture = store.add("buy milk");

    expect(capture.id).toBeTruthy();
    expect(capture.text).toBe("buy milk");
    expect(store.list()).toEqual([capture]);
  });

  it("lists captures in capture order (oldest first)", () => {
    const store = makeStore();

    const first = store.add("first");
    const second = store.add("second");

    expect(store.list()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(makeStore().list()).toEqual([]);
  });

  it("adds captures open (processedAt is null)", () => {
    const store = makeStore();

    const capture = store.add("open item");

    expect(capture.processedAt).toBeNull();
  });

  it("drops a processed capture from the Inbox but keeps the others", () => {
    const store = makeStore();
    const first = store.add("first");
    const second = store.add("second");

    const processed = store.process(first.id);

    expect(processed?.id).toBe(first.id);
    expect(processed?.processedAt).toBeTruthy();
    expect(store.list()).toEqual([second]);
  });

  it("returns null when processing an unknown id", () => {
    const store = makeStore();
    store.add("only");

    expect(store.process("nope")).toBeNull();
  });

  it("dedupes a repeated add with the same idempotency key", () => {
    const store = makeStore();

    const first = store.add("buy milk", "key-1");
    const replay = store.add("buy milk", "key-1");

    expect(replay).toEqual(first);
    expect(store.list()).toEqual([first]);
  });

  it("returns the original capture (not a second write) on a replay under the same key", () => {
    const store = makeStore();

    const first = store.add("first text", "key-1");
    // A retried write can carry the same key; the stored row wins, unchanged.
    const replay = store.add("second text", "key-1");

    expect(replay.id).toBe(first.id);
    expect(replay.text).toBe("first text");
    expect(store.list()).toEqual([first]);
  });

  it("treats adds without a key as independent", () => {
    const store = makeStore();

    const a = store.add("a");
    const b = store.add("b");

    expect(store.list()).toEqual([a, b]);
  });

  it("treats adds under different keys as independent", () => {
    const store = makeStore();

    const a = store.add("a", "key-1");
    const b = store.add("b", "key-2");

    expect(store.list()).toEqual([a, b]);
  });
});
