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
  it("advances one recurring occurrence exactly once", () => {
    const store = makeStore();
    const recurrence = {
      version: 1 as const,
      origin: "2026-09-01",
      anchor: "scheduled" as const,
      weekStartsOn: "MO" as const,
      pattern: {
        unit: "month" as const,
        interval: 1,
        on: [{ kind: "day" as const, day: 1 }],
      },
    };
    store.add("rent", "Pay rent", null, null, null, recurrence);

    const first = store.completeOccurrence(
      "rent",
      "2026-09-01",
      "2026-09-16",
    );
    const replay = store.completeOccurrence(
      "rent",
      "2026-09-01",
      "2026-09-16",
    );

    expect(first?.recurrenceDate).toBe("2026-10-01");
    expect(first?.showUpDate).toBe("2026-10-01");
    expect(first?.completedAt).toBeNull();
    expect(replay).toEqual(first);
  });

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

  it("moves a loose task into a project", () => {
    const store = makeStore();
    store.add("id-1", "buy milk");

    const moved = store.setProject("id-1", "proj-1");
    expect(moved?.projectId).toBe("proj-1");
  });

  it("moves a task back to loose", () => {
    const store = makeStore();
    store.add("id-1", "buy milk", null, "proj-1");

    const loosened = store.setProject("id-1", null);
    expect(loosened?.projectId).toBeNull();
  });

  it("keeps a task's show-up date when it moves into a project", () => {
    const store = makeStore();
    // A dated task filed into a project keeps its date (the date is the sole
    // commitment gate; filing does not change it).
    store.add("id-1", "buy milk", "2023-11-14", null);

    const moved = store.setProject("id-1", "proj-1");
    expect(moved?.projectId).toBe("proj-1");
    expect(moved?.showUpDate).toBe("2023-11-14");
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

  describe("deleteByProject", () => {
    it("deletes only tasks of the given project, leaving loose and other-project tasks", () => {
      const store = makeStore();
      store.add("t-loose", "loose", null, null);
      store.add("t-p1a", "p1 a", null, "p1");
      store.add("t-p1b", "p1 b", null, "p1");
      store.add("t-p2", "p2", null, "p2");

      const removed = store.deleteByProject("p1");

      expect(removed).toBe(2);
      expect(store.list().map((t) => t.id).sort()).toEqual(["t-loose", "t-p2"]);
    });

    it("deletes a completed task of the project too", () => {
      const store = makeStore();
      store.add("t-open", "open", null, "p1");
      store.add("t-done", "done", null, "p1");
      store.complete("t-done");

      const removed = store.deleteByProject("p1");

      // Both the open and the completed row are removed (2), even though only the
      // open one is in list().
      expect(removed).toBe(2);
      expect(store.list()).toEqual([]);
    });

    it("is a no-op for a project with no tasks", () => {
      const store = makeStore();
      store.add("t-loose", "loose", null, null);

      expect(store.deleteByProject("p1")).toBe(0);
      expect(store.list()).toHaveLength(1);
    });
  });
});
