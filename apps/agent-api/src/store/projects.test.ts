import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbProjectStore } from "./projects";

// A DbProjectStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's add/list SQL against an in-memory table.
const makeStore = () => new DbProjectStore(createDb(createMockStorage()));

describe("DbProjectStore", () => {
  it("stores an added project under the client id and returns it", () => {
    const store = makeStore();

    const project = store.add("id-1", "Run a 5K under 30 min");

    expect(project.id).toBe("id-1");
    expect(project.title).toBe("Run a 5K under 30 min");
    expect(store.list()).toEqual([project]);
  });

  it("applies the name-only creation defaults", () => {
    const store = makeStore();

    const project = store.add("id-1", "Have a baby");

    expect(project.icon).toBe("📁");
    expect(project.description).toBeNull();
    expect(project.status).toBe("next");
    expect(project.createdAt).toBeTruthy();
  });

  it("persists explicit fields when the caller supplies them", () => {
    const store = makeStore();

    const project = store.add("id-1", "Move house", {
      icon: "🏠",
      description: "Everything boxed by March",
      status: "active",
    });

    expect(project.icon).toBe("🏠");
    expect(project.description).toBe("Everything boxed by March");
    expect(project.status).toBe("active");
    expect(store.list()).toEqual([project]);
  });

  it("lists projects oldest first", () => {
    const store = makeStore();

    const first = store.add("id-1", "first");
    const second = store.add("id-2", "second");

    expect(store.list()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(makeStore().list()).toEqual([]);
  });

  it("dedupes a replayed add that re-sends the same id", () => {
    const store = makeStore();

    const first = store.add("id-1", "Run a 5K");
    // A retried write re-sends the same id; the stored row wins, unchanged.
    const replay = store.add("id-1", "different title");

    expect(replay.id).toBe(first.id);
    expect(replay.title).toBe("Run a 5K");
    expect(store.list()).toEqual([first]);
  });

  it("treats adds under different ids as independent", () => {
    const store = makeStore();

    const a = store.add("id-1", "a");
    const b = store.add("id-2", "b");

    expect(store.list()).toEqual([a, b]);
  });

  it("changes a project's status and returns the updated row", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K");

    const updated = store.setStatus("id-1", "active");

    expect(updated?.status).toBe("active");
    expect(store.list()[0].status).toBe("active");
  });

  it("returns null when setting the status of a missing project", () => {
    expect(makeStore().setStatus("nope", "active")).toBeNull();
  });

  it("drops a project from the list once its status is done", () => {
    const store = makeStore();
    store.add("id-1", "keep");
    store.add("id-2", "finish");

    store.setStatus("id-2", "done");

    expect(store.list().map((p) => p.id)).toEqual(["id-1"]);
  });
});
