import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbTaskStore } from "./tasks";
import { tasks } from "../UserDO/db/schema";

// A DbTaskStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's SQL against an in-memory table.
const makeStore = () => new DbTaskStore(createDb(createMockStorage()));

// A store plus its raw db handle, for tests that seed rows the store's own verbs
// would not produce (e.g. pre-0051 rows with a null sortKey).
const makeStoreWithDb = () => {
  const db = createDb(createMockStorage());
  return { store: new DbTaskStore(db), db };
};

describe("DbTaskStore", () => {
  it("stores an added task under the client id and returns it", () => {
    const store = makeStore();

    const task = store.add("id-1", "buy milk");

    expect(task.id).toBe("id-1");
    expect(task.text).toBe("buy milk");
    expect(task.completedAt).toBeNull();
    expect(store.list()).toEqual([task]);
  });

  it("defaults a loose add to a null show-up date", () => {
    const task = makeStore().add("id-1", "a loose thought");
    expect(task.showUpDate).toBeNull();
    expect(task.projectId).toBeNull();
  });

  it("mints a trailing sort key so a new task appends to the bottom", () => {
    const store = makeStore();

    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    expect(first.sortKey).toBeTruthy();
    expect(second.sortKey).toBeTruthy();
    // second sorts after first (trailing key), so list order is [first, second].
    expect(store.list().map((t) => t.id)).toEqual(["id-1", "id-2"]);
  });

  it("dedupes a replayed add on the id", () => {
    const store = makeStore();

    const first = store.add("id-1", "buy milk");
    const replay = store.add("id-1", "buy milk");

    expect(replay).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  it("lists only open tasks, in manual order", () => {
    const store = makeStore();

    const a = store.add("id-1", "a");
    store.add("id-2", "b");
    store.complete("id-2");
    const c = store.add("id-3", "c");

    expect(store.list().map((t) => t.id)).toEqual([a.id, c.id]);
  });

  it("completes and reopens a task", () => {
    const store = makeStore();
    store.add("id-1", "buy milk");

    const done = store.complete("id-1");
    expect(done?.completedAt).toBeTruthy();
    expect(store.list()).toEqual([]);

    const open = store.reopen("id-1");
    expect(open?.completedAt).toBeNull();
    expect(store.list().map((t) => t.id)).toEqual(["id-1"]);
  });

  it("returns null completing/reopening an unknown id", () => {
    const store = makeStore();
    expect(store.complete("nope")).toBeNull();
    expect(store.reopen("nope")).toBeNull();
  });

  it("reschedules a task to a day and clears it back to null", () => {
    const store = makeStore();
    store.add("id-1", "buy milk");

    const dated = store.reschedule("id-1", "2999-01-01");
    expect(dated?.showUpDate).toBe("2999-01-01");

    const cleared = store.reschedule("id-1", null);
    expect(cleared?.showUpDate).toBeNull();
  });

  it("takes a task on and parks it", () => {
    const store = makeStore();
    store.add("id-1", "buy milk", null, "proj-1");

    const takenOn = store.setTakenOn("id-1", "2023-11-14T00:00:00.000Z");
    expect(takenOn?.takenOnAt).toBe("2023-11-14T00:00:00.000Z");

    const parked = store.setTakenOn("id-1", null);
    expect(parked?.takenOnAt).toBeNull();
  });

  it("reorders a task between two others via a client-minted sort key", () => {
    const store = makeStore();
    const a = store.add("id-1", "a"); // sortKey "a0"
    const b = store.add("id-2", "b"); // sortKey "a1"
    store.add("id-3", "c"); // sortKey "a2", currently last

    // The client mints a key strictly between a ("a0") and b ("a1"); the store
    // just persists it. "a0V" sorts between them by raw codepoint.
    expect(a.sortKey! < "a0V" && "a0V" < b.sortKey!).toBe(true);
    const moved = store.reorder("id-3", "a0V");
    expect(moved?.sortKey).toBe("a0V");
    expect(store.list().map((t) => t.id)).toEqual(["id-1", "id-3", "id-2"]);
  });

  it("edits a task's text", () => {
    const store = makeStore();
    store.add("id-1", "buy milk");

    const edited = store.editText("id-1", "buy oat milk");
    expect(edited?.text).toBe("buy oat milk");
  });

  it("moves a loose task into a project and clears takenOnAt", () => {
    const store = makeStore();
    // A loose task the Home quick-add took on (a timestamp).
    store.add("id-1", "buy milk", null, null, "2023-11-14T00:00:00.000Z");

    const moved = store.setProject("id-1", "proj-1");
    expect(moved?.projectId).toBe("proj-1");
    // Filing into a project parks it: it must obey the project's curation gate,
    // not silently stay on Home.
    expect(moved?.takenOnAt).toBeNull();
  });

  it("moves a task back to loose and leaves takenOnAt untouched", () => {
    const store = makeStore();
    store.add("id-1", "buy milk", null, "proj-1", "2023-11-14T00:00:00.000Z");

    const loosened = store.setProject("id-1", null);
    expect(loosened?.projectId).toBeNull();
    // Clearing to loose does not touch takenOnAt (a loose task ignores it).
    expect(loosened?.takenOnAt).toBe("2023-11-14T00:00:00.000Z");
  });

  it("returns null moving an unknown id", () => {
    const store = makeStore();
    expect(store.setProject("nope", "proj-1")).toBeNull();
  });

  it("backfills null sort keys in createdAt order, idempotently", () => {
    const { store, db } = makeStoreWithDb();
    // Seed two pre-0051 rows (null sortKey) directly, out of createdAt order in
    // insertion order to prove the backfill orders by createdAt, not insertion.
    db.insert(tasks, {
      id: "id-late",
      text: "late",
      showUpDate: null,
      createdAt: "2023-11-14T00:00:02.000Z",
      completedAt: null,
      projectId: null,
      takenOnAt: null,
      sourceCaptureId: null,
      sortKey: null,
    });
    db.insert(tasks, {
      id: "id-early",
      text: "early",
      showUpDate: null,
      createdAt: "2023-11-14T00:00:01.000Z",
      completedAt: null,
      projectId: null,
      takenOnAt: null,
      sourceCaptureId: null,
      sortKey: null,
    });

    store.backfillSortKeys();

    const listed = store.list();
    expect(listed.every((t) => t.sortKey != null)).toBe(true);
    // createdAt order: early before late.
    expect(listed.map((t) => t.id)).toEqual(["id-early", "id-late"]);

    // Idempotent: a second run keys nothing new and preserves order.
    const before = store.list().map((t) => t.sortKey);
    store.backfillSortKeys();
    expect(store.list().map((t) => t.sortKey)).toEqual(before);
  });
});
