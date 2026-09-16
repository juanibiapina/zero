import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";
import { describe, expect, it } from "vitest";

import { DbProjectStore } from "./projects";
import { DbTaskStore } from "./tasks";
import { DbWaitingConditionStore } from "./waiting-conditions";

const makeStores = () => {
  const db = createDb(createMockStorage());
  return {
    projects: new DbProjectStore(db),
    tasks: new DbTaskStore(db),
    conditions: new DbWaitingConditionStore(db),
  };
};

const deleteProject = (stores: ReturnType<typeof makeStores>, id: string) => ({
  existed: stores.projects.delete(id),
  tasks: stores.tasks.deleteByProject(id),
  conditions: stores.conditions.deleteByProject(id),
  afters: stores.conditions.deleteByReferencedProject(id),
});

describe("Project delete cascade", () => {
  it("removes owned Tasks and Waiting while preserving unrelated rows", () => {
    const stores = makeStores();
    stores.projects.add("p1", "Ship it");
    stores.projects.add("p2", "Other");
    stores.tasks.add("loose", "loose", null, null);
    stores.tasks.add("p1-task", "p1 task", null, "p1");
    stores.tasks.add("p2-task", "p2 task", null, "p2");
    stores.conditions.addWaiting("p1-wait", "p1", "the letter");
    stores.conditions.addWaiting("p2-wait", "p2", "a reply");

    expect(deleteProject(stores, "p1")).toEqual({
      existed: true,
      tasks: 1,
      conditions: 1,
      afters: 0,
    });
    expect(stores.projects.list().map((project) => project.id)).toEqual(["p2"]);
    expect(stores.tasks.list().map((task) => task.id).sort()).toEqual([
      "loose",
      "p2-task",
    ]);
    expect(stores.conditions.listOpen().map((condition) => condition.id)).toEqual([
      "p2-wait",
    ]);
  });

  it("removes incoming After rows while preserving source Projects", () => {
    const stores = makeStores();
    stores.projects.add("source", "Move house");
    stores.projects.add("target", "Sell old house");
    stores.conditions.addAfter("relationship", "source", "target");

    expect(deleteProject(stores, "target")).toEqual({
      existed: true,
      tasks: 0,
      conditions: 0,
      afters: 1,
    });
    expect(stores.projects.list().map((project) => project.id)).toEqual([
      "source",
    ]);
    expect(stores.conditions.listOpen()).toEqual([]);
  });

  it("is idempotent", () => {
    const stores = makeStores();
    stores.projects.add("p1", "Ship it");
    stores.tasks.add("p1-task", "p1 task", null, "p1");

    expect(deleteProject(stores, "p1")).toEqual({
      existed: true,
      tasks: 1,
      conditions: 0,
      afters: 0,
    });
    expect(deleteProject(stores, "p1")).toEqual({
      existed: false,
      tasks: 0,
      conditions: 0,
      afters: 0,
    });
  });
});
