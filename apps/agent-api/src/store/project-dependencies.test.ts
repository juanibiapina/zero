import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";
import { describe, expect, it } from "vitest";

import {
  addProjectDependency,
  setProjectState,
} from "./project-dependencies";
import { DbProjectStore } from "./projects";
import { DbWaitingConditionStore } from "./waiting-conditions";

function stores() {
  const db = createDb(createMockStorage());
  return {
    projects: new DbProjectStore(db),
    conditions: new DbWaitingConditionStore(db),
  };
}

describe("project dependency coordination", () => {
  it("adds a valid edge exactly once on its client id", () => {
    const store = stores();
    store.projects.add("dependent", "Move house");
    store.projects.add("prerequisite", "Sell old house");

    const first = addProjectDependency(
      store.projects,
      store.conditions,
      "dependency",
      "dependent",
      "prerequisite",
    );
    const replay = addProjectDependency(
      store.projects,
      store.conditions,
      "dependency",
      "dependent",
      "prerequisite",
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      condition: {
        id: "dependency",
        projectId: "dependent",
        refId: "prerequisite",
        targetStatus: "done",
      },
    });
    expect(store.conditions.listOpenProjectDependencies()).toHaveLength(1);
  });

  it("rejects missing, Done, self, and duplicate relationships", () => {
    const store = stores();
    store.projects.add("dependent", "Move house");
    store.projects.add("prerequisite", "Sell old house");
    store.projects.add("done", "Already sold", { state: "done" });

    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "missing-dependent",
        "missing",
        "prerequisite",
      ),
    ).toEqual({ conflict: "missing-dependent" });
    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "missing-prerequisite",
        "dependent",
        "missing",
      ),
    ).toEqual({ conflict: "missing-prerequisite" });
    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "done-prerequisite",
        "dependent",
        "done",
      ),
    ).toEqual({ conflict: "prerequisite-done" });
    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "self",
        "dependent",
        "dependent",
      ),
    ).toEqual({ conflict: "self" });

    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "first",
        "dependent",
        "prerequisite",
      ),
    ).toHaveProperty("condition");
    expect(
      addProjectDependency(
        store.projects,
        store.conditions,
        "duplicate",
        "dependent",
        "prerequisite",
      ),
    ).toEqual({ conflict: "duplicate" });
  });

  it("rejects direct and transitive cycles without inserting an edge", () => {
    const store = stores();
    for (const id of ["a", "b", "c"]) store.projects.add(id, id);
    expect(
      addProjectDependency(store.projects, store.conditions, "b-c", "b", "c"),
    ).toHaveProperty("condition");
    expect(
      addProjectDependency(store.projects, store.conditions, "c-a", "c", "a"),
    ).toHaveProperty("condition");

    expect(
      addProjectDependency(store.projects, store.conditions, "a-c", "a", "c"),
    ).toEqual({ conflict: "cycle" });
    expect(
      addProjectDependency(store.projects, store.conditions, "a-b", "a", "b"),
    ).toEqual({ conflict: "cycle" });
    expect(store.conditions.listOpenProjectDependencies()).toHaveLength(2);
  });

  it("settles matching incoming dependencies when a prerequisite becomes Done", () => {
    const store = stores();
    for (const id of ["dependent", "other", "prerequisite"]) {
      store.projects.add(id, id);
    }
    store.conditions.addProjectDependency("matching", "dependent", "prerequisite");
    store.conditions.addProjectDependency("unrelated", "dependent", "other");
    store.conditions.add("ordinary", "dependent", "free-text", { text: "wait" });

    const result = setProjectState(
      store.projects,
      store.conditions,
      "prerequisite",
      "done",
    );

    expect(result.project?.state).toBe("done");
    expect(result.resolvedDependencies).toBe(1);
    expect(store.conditions.get("matching")?.resolvedAt).toBeTruthy();
    expect(store.conditions.get("unrelated")?.resolvedAt).toBeNull();
    expect(store.conditions.get("ordinary")?.resolvedAt).toBeNull();
  });
});
