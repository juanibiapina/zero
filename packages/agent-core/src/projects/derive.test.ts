import { describe, expect, it } from "vitest";

import {
  conditionSatisfied,
  projectDisplayStatus,
  unresolvedConditions,
  waitingSince,
  waitingUntil,
} from "./derive";
import type { Project, ProjectStatus } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

// A fixed local day. Task default showUpDate ("2026-01-01") is well before it,
// so a default task is shown-up and the pre-date-aware assertions still hold.
const TODAY = "2026-06-01";

function condition(over: Partial<WaitingCondition>): WaitingCondition {
  return {
    id: over.id ?? "c",
    projectId: over.projectId ?? "p",
    kind: over.kind ?? "free-text",
    text: over.text ?? null,
    refId: over.refId ?? null,
    targetStatus: over.targetStatus ?? null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function project(status: ProjectStatus): Project {
  return {
    id: "p",
    title: "p",
    icon: "📁",
    description: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? "t",
    text: "t",
    showUpDate: over.showUpDate !== undefined ? over.showUpDate : "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? "p",
    takenOnAt: over.takenOnAt ?? null,
    sortKey: over.sortKey ?? null,
  };
}

describe("projectDisplayStatus", () => {
  it("keeps backlog and done from the stored value", () => {
    expect(projectDisplayStatus(project("backlog"), [], TODAY)).toBe("backlog");
    expect(projectDisplayStatus(project("done"), [], TODAY)).toBe("done");
  });

  it("is next when in play with no taken-on task", () => {
    expect(projectDisplayStatus(project("next"), [], TODAY)).toBe("next");
    expect(
      projectDisplayStatus(project("next"), [task({ takenOnAt: null })], TODAY),
    ).toBe("next");
  });

  it("is active when in play with a shown-up taken-on open task", () => {
    expect(
      projectDisplayStatus(
        project("next"),
        [task({ takenOnAt: "2026-01-02T00:00:00.000Z" })],
        TODAY,
      ),
    ).toBe("active");
  });

  it("ignores a completed taken-on task (drops back to next)", () => {
    expect(
      projectDisplayStatus(
        project("active"),
        [
          task({
            takenOnAt: "2026-01-02T00:00:00.000Z",
            completedAt: "2026-01-03T00:00:00.000Z",
          }),
        ],
        TODAY,
      ),
    ).toBe("next");
  });

  it("ignores tasks of other projects", () => {
    expect(
      projectDisplayStatus(
        project("next"),
        [task({ projectId: "other", takenOnAt: "2026-01-02T00:00:00.000Z" })],
        TODAY,
      ),
    ).toBe("next");
  });

  it("is waiting when an unresolved condition exists and nothing is taken on", () => {
    expect(
      projectDisplayStatus(project("next"), [], TODAY, [condition({})]),
    ).toBe("waiting");
  });

  it("a shown-up taken-on open task overrides an unresolved condition (active, not waiting)", () => {
    const taken = task({ takenOnAt: "2026-01-02T00:00:00.000Z" });
    expect(
      projectDisplayStatus(project("next"), [taken], TODAY, [condition({})]),
    ).toBe("active");
  });

  it("drops back to waiting (not next) when the taken-on task is completed", () => {
    const done = task({
      takenOnAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(
      projectDisplayStatus(project("next"), [done], TODAY, [condition({})]),
    ).toBe("waiting");
  });

  it("leaves waiting once the condition resolves", () => {
    expect(
      projectDisplayStatus(project("next"), [], TODAY, [
        condition({ resolvedAt: "2026-01-03T00:00:00.000Z" }),
      ]),
    ).toBe("next");
  });

  // --- date-aware cases (plan 3) ---

  it("a future-dated taken-on task does not keep the project active", () => {
    const future = task({
      takenOnAt: "2026-01-02T00:00:00.000Z",
      showUpDate: "2026-07-01",
    });
    expect(projectDisplayStatus(project("next"), [future], TODAY)).toBe(
      "waiting",
    );
  });

  it("derives waiting from a future-dated taken-on task with no condition", () => {
    const future = task({
      takenOnAt: "2026-01-02T00:00:00.000Z",
      showUpDate: "2026-07-01",
    });
    expect(projectDisplayStatus(project("next"), [future], TODAY)).toBe(
      "waiting",
    );
  });

  it("returns to active when a taken-on task's date arrives (shown up)", () => {
    const arrived = task({
      takenOnAt: "2026-01-02T00:00:00.000Z",
      showUpDate: TODAY,
    });
    expect(projectDisplayStatus(project("next"), [arrived], TODAY)).toBe(
      "active",
    );
  });

  it("is next (not waiting) for a not-taken task whose date passed", () => {
    const shownUpNotTaken = task({ takenOnAt: null, showUpDate: "2026-05-01" });
    expect(
      projectDisplayStatus(project("next"), [shownUpNotTaken], TODAY),
    ).toBe("next");
  });
});

describe("waitingUntil", () => {
  it("is null when the project has no future-dated taken-on task", () => {
    expect(waitingUntil(project("next"), [], TODAY)).toBeNull();
    expect(
      waitingUntil(
        project("next"),
        [task({ takenOnAt: "2026-01-02T00:00:00.000Z", showUpDate: TODAY })],
        TODAY,
      ),
    ).toBeNull();
  });

  it("picks the soonest of several future taken-on tasks", () => {
    const out = waitingUntil(
      project("next"),
      [
        task({ id: "a", takenOnAt: "2026-01-02T00:00:00.000Z", showUpDate: "2026-09-01" }),
        task({ id: "b", takenOnAt: "2026-01-02T00:00:00.000Z", showUpDate: "2026-07-15" }),
        task({ id: "c", takenOnAt: "2026-01-02T00:00:00.000Z", showUpDate: "2026-08-01" }),
      ],
      TODAY,
    );
    expect(out).toBe("2026-07-15");
  });

  it("ignores a future-dated task that is not taken on", () => {
    expect(
      waitingUntil(
        project("next"),
        [task({ takenOnAt: null, showUpDate: "2026-07-01" })],
        TODAY,
      ),
    ).toBeNull();
  });
});

describe("conditionSatisfied", () => {
  it("free-text: satisfied only when resolvedAt is set", () => {
    expect(conditionSatisfied(condition({}), [], [], TODAY)).toBe(false);
    expect(
      conditionSatisfied(condition({ resolvedAt: "2026-01-03" }), [], [], TODAY),
    ).toBe(true);
  });

  it("task-done: satisfied when the referenced task is completed", () => {
    const c = condition({ kind: "task-done", refId: "t1" });
    expect(conditionSatisfied(c, [task({ id: "t1" })], [], TODAY)).toBe(false);
    expect(
      conditionSatisfied(
        c,
        [task({ id: "t1", completedAt: "2026-01-03" })],
        [],
        TODAY,
      ),
    ).toBe(true);
  });

  it("project-status: satisfied when the referenced project reaches the target", () => {
    const c = condition({
      kind: "project-status",
      refId: "x",
      targetStatus: "done",
    });
    const other = { ...project("done"), id: "x" };
    expect(conditionSatisfied(c, [], [other], TODAY)).toBe(true);
    const notYet = { ...project("next"), id: "x" };
    expect(conditionSatisfied(c, [], [notYet], TODAY)).toBe(false);
  });
});

describe("waitingSince", () => {
  it("is null when the project has no conditions", () => {
    expect(waitingSince(project("next"), [], TODAY, [])).toBeNull();
  });

  it("is null when every condition is resolved or satisfied", () => {
    expect(
      waitingSince(project("next"), [], TODAY, [
        condition({ resolvedAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toBeNull();
  });

  it("returns the oldest unresolved condition's createdAt", () => {
    const out = waitingSince(project("next"), [], TODAY, [
      condition({ id: "a", createdAt: "2026-03-01T00:00:00.000Z" }),
      condition({ id: "b", createdAt: "2026-01-15T00:00:00.000Z" }),
      condition({ id: "c", createdAt: "2026-02-10T00:00:00.000Z" }),
    ]);
    expect(out).toBe("2026-01-15T00:00:00.000Z");
  });

  it("ignores a resolved condition even if it is the oldest", () => {
    const out = waitingSince(project("next"), [], TODAY, [
      condition({
        id: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: "2026-01-05T00:00:00.000Z",
      }),
      condition({ id: "open", createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(out).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("unresolvedConditions", () => {
  it("returns only this project's open, unmet conditions", () => {
    const p = project("next");
    const mine = condition({ id: "a", projectId: "p" });
    const resolved = condition({
      id: "b",
      projectId: "p",
      resolvedAt: "2026-01-03",
    });
    const other = condition({ id: "c", projectId: "other" });
    const out = unresolvedConditions(p, [mine, resolved, other], [], [], TODAY);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});
