import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbCaptureStore } from "./captures";

// A DbCaptureStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's add/list SQL against an in-memory table.
const makeStore = () => new DbCaptureStore(createDb(createMockStorage()));

// A fixed "today" for the visibility filter. Added captures default to a null
// show-up date, so they are visible on any day; tests that exercise the date
// filter pass their own boundary values.
const TODAY = "2024-03-09";

describe("DbCaptureStore", () => {
  it("stores an added capture under the client id and returns it", () => {
    const store = makeStore();

    const capture = store.add("id-1", "buy milk");

    expect(capture.id).toBe("id-1");
    expect(capture.text).toBe("buy milk");
    expect(store.list(TODAY)).toEqual([capture]);
  });

  it("lists captures in capture order (oldest first)", () => {
    const store = makeStore();

    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    expect(store.list(TODAY)).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(makeStore().list(TODAY)).toEqual([]);
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
    expect(store.list(TODAY)).toEqual([second]);
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
    expect(store.list(TODAY)).toEqual([first]);
  });

  it("treats adds under different ids as independent", () => {
    const store = makeStore();

    const a = store.add("id-1", "a");
    const b = store.add("id-2", "b");

    expect(store.list(TODAY)).toEqual([a, b]);
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

    expect(store.list(TODAY).map((c) => c.id)).toEqual([first.id, second.id]);
    expect(store.list(TODAY)[0].text).toBe("first edited");
  });

  it("returns null when editing an unknown id", () => {
    const store = makeStore();
    store.add("id-1", "only");

    expect(store.editText("nope", "x")).toBeNull();
  });

  it("adds a capture with a null show-up date (always visible)", () => {
    const store = makeStore();

    const capture = store.add("id-1", "plain");

    expect(capture.showUpDate).toBeNull();
  });

  it("reschedules a capture to a future day and returns the updated row", () => {
    const store = makeStore();
    const original = store.add("id-1", "later");

    const rescheduled = store.reschedule("id-1", "2099-01-01");

    expect(rescheduled?.id).toBe("id-1");
    expect(rescheduled?.showUpDate).toBe("2099-01-01");
    // Only the date changes: text/createdAt/processedAt are untouched.
    expect(rescheduled?.text).toBe("later");
    expect(rescheduled?.createdAt).toBe(original.createdAt);
    expect(rescheduled?.processedAt).toBeNull();
  });

  it("clears a capture's show-up date with null", () => {
    const store = makeStore();
    store.add("id-1", "back to plain");
    store.reschedule("id-1", "2099-01-01");

    const cleared = store.reschedule("id-1", null);

    expect(cleared?.showUpDate).toBeNull();
  });

  it("returns null when rescheduling an unknown id", () => {
    const store = makeStore();
    store.add("id-1", "only");

    expect(store.reschedule("nope", "2099-01-01")).toBeNull();
  });

  it("list(today) shows a null-date capture on any day", () => {
    const store = makeStore();
    const plain = store.add("id-1", "plain");

    expect(store.list("2024-03-09")).toEqual([plain]);
  });

  it("list(today) shows a capture whose show-up date is today or overdue", () => {
    const store = makeStore();
    store.add("id-today", "today");
    store.add("id-past", "past");
    store.reschedule("id-today", "2024-03-09");
    store.reschedule("id-past", "2020-01-01");

    expect(store.list("2024-03-09").map((c) => c.id)).toEqual([
      "id-today",
      "id-past",
    ]);
  });

  it("list(today) hides a future-dated capture until its day", () => {
    const store = makeStore();
    const plain = store.add("id-plain", "plain");
    store.add("id-future", "future");
    store.reschedule("id-future", "2099-01-01");

    expect(store.list("2024-03-09")).toEqual([plain]);
  });
});
