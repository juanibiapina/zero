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
});
