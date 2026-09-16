import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";
import { describe, expect, it } from "vitest";

import { addProjectAfter, setProjectState } from "./project-afters";
import { DbProjectStore } from "./projects";
import { DbWaitingConditionStore } from "./waiting-conditions";

function stores() {
  const db = createDb(createMockStorage());
  return {
    projects: new DbProjectStore(db),
    conditions: new DbWaitingConditionStore(db),
  };
}

describe("Project After coordination", () => {
  it("adds a valid relationship exactly once on its client id", () => {
    const store = stores();
    store.projects.add("source", "Buy a dog");
    store.projects.add("target", "Buy a house");

    const first = addProjectAfter(
      store.projects,
      store.conditions,
      "relationship",
      "source",
      "target",
    );
    const replay = addProjectAfter(
      store.projects,
      store.conditions,
      "relationship",
      "source",
      "target",
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      relationship: {
        id: "relationship",
        projectId: "source",
        refId: "target",
      },
    });
    expect(store.conditions.listOpenAfters()).toHaveLength(1);
  });

  it("rejects missing, Done, self, duplicate, and cyclic relationships", () => {
    const store = stores();
    for (const id of ["a", "b", "c"]) store.projects.add(id, id);
    store.projects.add("done", "Done", { state: "done" });

    expect(
      addProjectAfter(store.projects, store.conditions, "x", "missing", "a"),
    ).toEqual({ conflict: "missing-source" });
    expect(
      addProjectAfter(store.projects, store.conditions, "x", "a", "missing"),
    ).toEqual({ conflict: "missing-target" });
    expect(
      addProjectAfter(store.projects, store.conditions, "x", "a", "done"),
    ).toEqual({ conflict: "target-done" });
    expect(
      addProjectAfter(store.projects, store.conditions, "x", "a", "a"),
    ).toEqual({ conflict: "self" });

    expect(
      addProjectAfter(store.projects, store.conditions, "a-b", "a", "b"),
    ).toHaveProperty("relationship");
    expect(
      addProjectAfter(store.projects, store.conditions, "duplicate", "a", "b"),
    ).toEqual({ conflict: "duplicate" });
    expect(
      addProjectAfter(store.projects, store.conditions, "b-c", "b", "c"),
    ).toHaveProperty("relationship");
    expect(
      addProjectAfter(store.projects, store.conditions, "c-a", "c", "a"),
    ).toEqual({ conflict: "cycle" });
  });

  it("settles incoming relationships on completion and restores them on Undo", () => {
    const store = stores();
    for (const id of ["source", "other", "target"]) {
      store.projects.add(id, id);
    }
    store.conditions.addAfter("matching", "source", "target");
    store.conditions.addAfter("unrelated", "source", "other");
    store.conditions.addWaiting("waiting", "source", "a reply");

    const completed = setProjectState(
      store.projects,
      store.conditions,
      "target",
      "done",
    );
    expect(completed.project?.state).toBe("done");
    expect(completed.resolvedAfters).toBe(1);
    expect(completed.restoredAfters).toBe(0);
    expect(store.conditions.get("matching")?.resolvedAt).toBeTruthy();
    expect(store.conditions.get("unrelated")?.resolvedAt).toBeNull();
    expect(store.conditions.get("waiting")?.resolvedAt).toBeNull();

    const reopened = setProjectState(
      store.projects,
      store.conditions,
      "target",
      "in-play",
    );
    expect(reopened.resolvedAfters).toBe(0);
    expect(reopened.restoredAfters).toBe(1);
    expect(store.conditions.get("matching")?.resolvedAt).toBeNull();
  });
});
