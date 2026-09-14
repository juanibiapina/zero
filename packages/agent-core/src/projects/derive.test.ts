import { describe, expect, it } from "vitest";

import {
  conditionSatisfied,
  projectDisplayStatus,
  unresolvedConditions,
  waitingSince,
  waitingUntil,
} from "./derive";
import type { Project, ProjectState } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

const TODAY = "2026-06-01";

function condition(over: Partial<WaitingCondition> = {}): WaitingCondition {
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

function project(state: ProjectState = "in-play"): Project {
  return {
    id: "p",
    title: "p",
    icon: "📁",
    description: null,
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? "t",
    text: over.text ?? "t",
    showUpDate:
      over.showUpDate !== undefined ? over.showUpDate : "2026-01-01",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? "p",
    sortKey: over.sortKey ?? null,
  };
}

describe("projectDisplayStatus", () => {
  it("returns persisted Backlog and Done states", () => {
    expect(projectDisplayStatus(project("backlog"), [], TODAY)).toBe("backlog");
    expect(projectDisplayStatus(project("done"), [], TODAY)).toBe("done");
  });

  it("calculates Next for an in-play project with no dated task", () => {
    expect(projectDisplayStatus(project(), [], TODAY)).toBe("next");
    expect(
      projectDisplayStatus(project(), [task({ showUpDate: null })], TODAY),
    ).toBe("next");
  });

  it("calculates Active from a shown-up scheduled open task", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ showUpDate: "2026-01-01" })],
        TODAY,
      ),
    ).toBe("active");
  });

  it("ignores completed and other-project tasks", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ completedAt: "2026-01-03T00:00:00.000Z" })],
        TODAY,
      ),
    ).toBe("next");
    expect(
      projectDisplayStatus(
        project(),
        [task({ projectId: "other", showUpDate: "2026-01-01" })],
        TODAY,
      ),
    ).toBe("next");
  });

  it("calculates Waiting from an unresolved condition", () => {
    expect(projectDisplayStatus(project(), [], TODAY, [condition()])).toBe(
      "waiting",
    );
  });

  it("lets shown-up scheduled work override an unresolved condition", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ showUpDate: "2026-01-01" })],
        TODAY,
        [condition()],
      ),
    ).toBe("active");
  });

  it("returns to Waiting when that active task completes", () => {
    expect(
      projectDisplayStatus(
        project(),
        [
          task({
            showUpDate: "2026-01-01",
            completedAt: "2026-01-03T00:00:00.000Z",
          }),
        ],
        TODAY,
        [condition()],
      ),
    ).toBe("waiting");
  });

  it("leaves Waiting after a condition resolves", () => {
    expect(
      projectDisplayStatus(project(), [], TODAY, [
        condition({ resolvedAt: "2026-01-03T00:00:00.000Z" }),
      ]),
    ).toBe("next");
  });

  it("calculates Waiting from a future task and Active when its day arrives", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ showUpDate: "2026-07-01" })],
        TODAY,
      ),
    ).toBe("waiting");
    expect(
      projectDisplayStatus(
        project(),
        [task({ showUpDate: TODAY })],
        TODAY,
      ),
    ).toBe("active");
  });
});

describe("waitingUntil", () => {
  it("returns no day without a future open task", () => {
    expect(waitingUntil(project(), [], TODAY)).toBeNull();
    expect(waitingUntil(project(), [task({ showUpDate: TODAY })], TODAY)).toBeNull();
  });

  it("returns the soonest future day", () => {
    expect(
      waitingUntil(
        project(),
        [
          task({ id: "a", showUpDate: "2026-09-01" }),
          task({ id: "b", showUpDate: "2026-07-15" }),
          task({ id: "c", showUpDate: "2026-08-01" }),
        ],
        TODAY,
      ),
    ).toBe("2026-07-15");
  });

  it("ignores completed future tasks", () => {
    expect(
      waitingUntil(
        project(),
        [task({ showUpDate: "2026-07-01", completedAt: "2026-06-02" })],
        TODAY,
      ),
    ).toBeNull();
  });
});

describe("conditionSatisfied", () => {
  it("settles free text only when resolvedAt is set", () => {
    expect(conditionSatisfied(condition(), [], [], TODAY)).toBe(false);
    expect(
      conditionSatisfied(
        condition({ resolvedAt: "2026-01-03" }),
        [],
        [],
        TODAY,
      ),
    ).toBe(true);
  });

  it("settles task-done when the referenced task is completed", () => {
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

  it("settles project-status when the referenced display status matches", () => {
    const c = condition({
      kind: "project-status",
      refId: "x",
      targetStatus: "done",
    });
    expect(
      conditionSatisfied(c, [], [{ ...project("done"), id: "x" }], TODAY),
    ).toBe(true);
    expect(
      conditionSatisfied(c, [], [{ ...project(), id: "x" }], TODAY),
    ).toBe(false);
  });
});

describe("waitingSince", () => {
  it("returns no instant without an unresolved condition", () => {
    expect(waitingSince(project(), [], TODAY, [])).toBeNull();
    expect(
      waitingSince(project(), [], TODAY, [
        condition({ resolvedAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toBeNull();
  });

  it("returns the oldest unresolved condition instant", () => {
    expect(
      waitingSince(project(), [], TODAY, [
        condition({ id: "a", createdAt: "2026-03-01T00:00:00.000Z" }),
        condition({ id: "b", createdAt: "2026-01-15T00:00:00.000Z" }),
        condition({ id: "c", createdAt: "2026-02-10T00:00:00.000Z" }),
      ]),
    ).toBe("2026-01-15T00:00:00.000Z");
  });

  it("ignores resolved conditions", () => {
    expect(
      waitingSince(project(), [], TODAY, [
        condition({
          id: "old",
          createdAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: "2026-01-05T00:00:00.000Z",
        }),
        condition({ id: "open", createdAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("unresolvedConditions", () => {
  it("returns only this project's open unmet conditions", () => {
    const mine = condition({ id: "a" });
    const resolved = condition({
      id: "b",
      resolvedAt: "2026-01-03",
    });
    const other = condition({ id: "c", projectId: "other" });

    expect(
      unresolvedConditions(project(), [mine, resolved, other], [], [], TODAY).map(
        (c) => c.id,
      ),
    ).toEqual(["a"]);
  });
});
