import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbProjectStore } from "./projects";
import { DbTaskStore } from "./tasks";
import { DbWaitingConditionStore } from "./waiting-conditions";

// The project-delete cascade, exercised across the three real stores over one
// shared database — exactly what UserDO.deleteProject orchestrates (the
// composition root that holds all three stores). UserDO itself is a Durable
// Object with no non-workerd test harness, so this proves the cross-table
// cascade at the seam that matters (delete a project → its tasks and conditions
// go, loose and other-project rows stay) without booting the DO. The leaf verbs
// (deleteByProject on each store) are unit-tested in their own files; this
// asserts they coexist and cascade correctly in one db.
const makeStores = () => {
  const db = createDb(createMockStorage());
  return {
    projects: new DbProjectStore(db),
    tasks: new DbTaskStore(db),
    conditions: new DbWaitingConditionStore(db),
  };
};

// Mirror of UserDO.deleteProject: delete the project, then cascade to its tasks
// and waiting conditions.
const deleteProject = (s: ReturnType<typeof makeStores>, id: string) => ({
  existed: s.projects.delete(id),
  tasks: s.tasks.deleteByProject(id),
  conditions: s.conditions.deleteByProject(id),
  dependencies: s.conditions.deleteByReferencedProject(id),
});

describe("project delete cascade", () => {
  it("removes the project's tasks and conditions, keeping loose and other-project rows", () => {
    const s = makeStores();
    s.projects.add("p1", "Ship it");
    s.projects.add("p2", "Other");
    s.tasks.add("t-loose", "loose", null, null);
    s.tasks.add("t-p1a", "p1 a", null, "p1");
    s.tasks.add("t-p1b", "p1 b", null, "p1");
    s.tasks.add("t-p2", "p2 task", null, "p2");
    s.conditions.add("c-p1", "p1", "free-text", { text: "the letter" });
    s.conditions.add("c-p2", "p2", "free-text", { text: "a reply" });

    const result = deleteProject(s, "p1");

    expect(result).toEqual({
      existed: true,
      tasks: 2,
      conditions: 1,
      dependencies: 0,
    });
    // The project is gone from the working list.
    expect(s.projects.list().map((p) => p.id)).toEqual(["p2"]);
    // The loose task and p2's task remain; p1's tasks are gone.
    expect(s.tasks.list().map((t) => t.id).sort()).toEqual(["t-loose", "t-p2"]);
    // p1's condition is gone; p2's stays.
    expect(s.conditions.listOpen().map((c) => c.id)).toEqual(["c-p2"]);
  });

  it("removes incoming dependencies while preserving their dependent projects", () => {
    const s = makeStores();
    s.projects.add("dependent", "Move house");
    s.projects.add("prerequisite", "Sell old house");
    s.conditions.addProjectDependency(
      "dependency",
      "dependent",
      "prerequisite",
    );

    expect(deleteProject(s, "prerequisite")).toEqual({
      existed: true,
      tasks: 0,
      conditions: 0,
      dependencies: 1,
    });
    expect(s.projects.list().map((project) => project.id)).toEqual([
      "dependent",
    ]);
    expect(s.conditions.listOpen()).toEqual([]);
  });

  it("is idempotent: a replayed delete of an already-gone project is a clean no-op", () => {
    const s = makeStores();
    s.projects.add("p1", "Ship it");
    s.tasks.add("t-p1", "p1 task", null, "p1");

    expect(deleteProject(s, "p1")).toEqual({
      existed: true,
      tasks: 1,
      conditions: 0,
      dependencies: 0,
    });
    // A second delete finds nothing on all three.
    expect(deleteProject(s, "p1")).toEqual({
      existed: false,
      tasks: 0,
      conditions: 0,
      dependencies: 0,
    });
  });
});
