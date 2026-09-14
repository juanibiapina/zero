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
    expect(project.state).toBe("in-play");
    expect(project.createdAt).toBeTruthy();
  });

  it("persists explicit fields when the caller supplies them", () => {
    const store = makeStore();

    const project = store.add("id-1", "Move house", {
      icon: "🏠",
      description: "Everything boxed by March",
      state: "backlog",
    });

    expect(project.icon).toBe("🏠");
    expect(project.description).toBe("Everything boxed by March");
    expect(project.state).toBe("backlog");
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

  it("changes a project's state and returns the updated row", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K");

    const updated = store.setState("id-1", "backlog");

    expect(updated?.state).toBe("backlog");
    expect(store.list()[0].state).toBe("backlog");
  });

  it("returns null when setting the state of a missing project", () => {
    expect(makeStore().setState("nope", "backlog")).toBeNull();
  });

  it("drops a project from the list once its state is done", () => {
    const store = makeStore();
    store.add("id-1", "keep");
    store.add("id-2", "finish");

    store.setState("id-2", "done");

    expect(store.list().map((p) => p.id)).toEqual(["id-1"]);
  });

  it("edits a project's title, icon, and description", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K");

    const updated = store.edit("id-1", {
      title: "Run a 5K under 30 min",
      icon: "🏃",
      description: "By June",
    });

    expect(updated?.title).toBe("Run a 5K under 30 min");
    expect(updated?.icon).toBe("🏃");
    expect(updated?.description).toBe("By June");
  });

  it("edits only the fields present and leaves the rest", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K", { icon: "🏃", description: "keep me" });

    const updated = store.edit("id-1", { title: "Run a 10K" });

    expect(updated?.title).toBe("Run a 10K");
    expect(updated?.icon).toBe("🏃");
    expect(updated?.description).toBe("keep me");
  });

  it("clears a description with null", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K", { description: "old" });

    const updated = store.edit("id-1", { description: null });

    expect(updated?.description).toBeNull();
  });

  it("does not change state through edit", () => {
    const store = makeStore();
    store.add("id-1", "Run a 5K", { state: "backlog" });

    const updated = store.edit("id-1", { title: "renamed" });

    expect(updated?.state).toBe("backlog");
  });

  it("returns null when editing a missing project", () => {
    expect(makeStore().edit("nope", { title: "x" })).toBeNull();
  });

  it("permanently deletes a project", () => {
    const store = makeStore();
    store.add("id-1", "keep");
    store.add("id-2", "remove");

    const existed = store.delete("id-2");

    expect(existed).toBe(true);
    expect(store.list().map((p) => p.id)).toEqual(["id-1"]);
  });

  it("treats deleting a missing project as a no-op", () => {
    const store = makeStore();
    store.add("id-1", "keep");

    // Idempotent: a replayed delete of an already-gone project must not throw
    // and must report that nothing existed.
    expect(store.delete("nope")).toBe(false);
    expect(store.list().map((p) => p.id)).toEqual(["id-1"]);
  });
});
