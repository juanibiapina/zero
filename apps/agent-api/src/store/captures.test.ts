import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { captures } from "../UserDO/db/schema";
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

  it("lists an open capture regardless of its show-up date (client filters)", () => {
    const store = makeStore();
    const plain = store.add("id-plain", "plain");
    const future = store.add("id-future", "future");
    store.reschedule("id-future", "2099-01-01");

    // The server returns every open capture, future-dated included; the client
    // splits them into Captures and Upcoming.
    expect(store.list().map((c) => c.id)).toEqual([plain.id, future.id]);
    expect(store.list().find((c) => c.id === "id-future")?.showUpDate).toBe(
      "2099-01-01",
    );
  });

  it("drops a processed capture from the open list", () => {
    const store = makeStore();
    const open = store.add("id-open", "open");
    store.add("id-done", "done");
    store.process("id-done");

    expect(store.list().map((c) => c.id)).toEqual([open.id]);
  });

  it("mints a trailing sort key on add, so a new capture sorts after existing", () => {
    const store = makeStore();
    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    expect(first.sortKey).not.toBeNull();
    expect(second.sortKey).not.toBeNull();
    // Second's key sorts after first's (codepoint), so list order matches
    // insertion order.
    expect(second.sortKey! > first.sortKey!).toBe(true);
    expect(store.list().map((c) => c.id)).toEqual(["id-1", "id-2"]);
  });

  it("reorders a capture by setting its sort key idempotently", () => {
    const store = makeStore();
    const a = store.add("id-a", "a");
    store.add("id-b", "b");
    store.add("id-c", "c");

    // Move c between a and b by minting a key between their keys.
    const between = a.sortKey! + "V"; // a valid base-62 key strictly after a's, before b's
    const reordered = store.reorder("id-c", between);
    expect(reordered?.sortKey).toBe(between);
    // Idempotent replay.
    expect(store.reorder("id-c", between)?.sortKey).toBe(between);
    expect(store.list().map((c) => c.id)).toEqual(["id-a", "id-c", "id-b"]);
  });

  it("returns null when reordering an unknown id", () => {
    const store = makeStore();
    store.add("id-1", "only");
    expect(store.reorder("nope", "a5")).toBeNull();
  });

  it("backfills sort keys in createdAt order and is a no-op on a second run", () => {
    // Seed legacy rows with a null sortKey directly, mimicking the pre-backfill
    // state right after migration 0045's ADD COLUMN.
    const db = createDb(createMockStorage());
    const seed = (id: string, createdAt: string) =>
      db.insert(captures, {
        id,
        text: id,
        createdAt,
        processedAt: null,
        showUpDate: null,
        sortKey: null,
      });
    // Insert out of createdAt order to prove the backfill sorts by createdAt.
    seed("id-b", "2023-02-01T00:00:00.000Z");
    seed("id-a", "2023-01-01T00:00:00.000Z");
    seed("id-c", "2023-03-01T00:00:00.000Z");

    const store = new DbCaptureStore(db);
    store.backfillSortKeys();

    // Every row now has a key, and the list order is oldest-first (the legacy
    // createdAt order preserved).
    const rows = store.list();
    expect(rows.map((c) => c.id)).toEqual(["id-a", "id-b", "id-c"]);
    expect(rows.every((c) => c.sortKey != null && c.sortKey.length > 0)).toBe(true);

    // Second run is a no-op: no NULL rows remain, keys unchanged.
    const before = store.list().map((c) => c.sortKey);
    store.backfillSortKeys();
    const after = store.list().map((c) => c.sortKey);
    expect(after).toEqual(before);
  });

  it("sorts a null (unkeyed) sortKey last, behind keyed rows", () => {
    // Mix a keyed row and a null (legacy, unkeyed) row directly, then list.
    const db = createDb(createMockStorage());
    db.insert(captures, {
      id: "id-null",
      text: "unkeyed",
      createdAt: "2023-01-01T00:00:00.000Z",
      processedAt: null,
      showUpDate: null,
      sortKey: null,
    });
    db.insert(captures, {
      id: "id-keyed",
      text: "keyed",
      createdAt: "2023-02-01T00:00:00.000Z",
      processedAt: null,
      showUpDate: null,
      sortKey: "a0",
    });
    const store = new DbCaptureStore(db);

    // Keyed row first even though it is newer; the null row falls to the bottom.
    expect(store.list().map((c) => c.id)).toEqual(["id-keyed", "id-null"]);
  });
});
