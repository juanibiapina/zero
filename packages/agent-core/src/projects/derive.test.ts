import { describe, expect, it } from "vitest";

import {
  projectDisplayStatus,
  unresolvedConditions,
  waitingSince,
  waitingUntil,
} from "./derive";
import type { Project, ProjectState } from "./types";
import type { Task } from "../tasks/types";
import type {
  ManualWaitingCondition,
  ProjectAfter,
} from "../waits/types";

const TODAY = "2026-06-01";

function waiting(
  over: Partial<ManualWaitingCondition> = {},
): ManualWaitingCondition {
  return {
    id: over.id ?? "wait",
    projectId: over.projectId ?? "p",
    kind: "free-text",
    text: over.text ?? "a reply",
    refId: null,
    targetStatus: null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function after(over: Partial<ProjectAfter> = {}): ProjectAfter {
  return {
    id: over.id ?? "after",
    projectId: over.projectId ?? "p",
    kind: "project-status",
    text: null,
    refId: over.refId ?? "target",
    targetStatus: "done",
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function project(
  state: ProjectState = "in-play",
  id = "p",
): Project {
  return {
    id,
    title: id,
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
  it("returns persisted Backlog and Done before calculated attention", () => {
    const conditions = [waiting(), after()];
    const tasks = [task()];
    expect(
      projectDisplayStatus(project("backlog"), tasks, TODAY, conditions, [
        project("in-play", "target"),
      ]),
    ).toBe("backlog");
    expect(
      projectDisplayStatus(project("done"), tasks, TODAY, conditions, [
        project("in-play", "target"),
      ]),
    ).toBe("done");
  });

  it("calculates Next for an empty or undated In-play Project", () => {
    expect(projectDisplayStatus(project(), [], TODAY)).toBe("next");
    expect(
      projectDisplayStatus(project(), [task({ showUpDate: null })], TODAY),
    ).toBe("next");
  });

  it("calculates Active from an arrived open Task", () => {
    expect(projectDisplayStatus(project(), [task()], TODAY)).toBe("active");
  });

  it("lets arrived work override both manual Waiting and After", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task()],
        TODAY,
        [waiting(), after()],
        [project("in-play", "target")],
      ),
    ).toBe("active");
  });

  it("lets manual Waiting override After", () => {
    expect(
      projectDisplayStatus(project(), [], TODAY, [waiting(), after()], [
        project("in-play", "target"),
      ]),
    ).toBe("waiting");
  });

  it("lets a future Task override After with Waiting", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ showUpDate: "2026-07-01" })],
        TODAY,
        [after()],
        [project("in-play", "target")],
      ),
    ).toBe("waiting");
  });

  it("calculates After only when no dated work or manual wait needs attention", () => {
    expect(
      projectDisplayStatus(project(), [], TODAY, [after()], [
        project("in-play", "target"),
      ]),
    ).toBe("after");
  });

  it("leaves After after the final relationship settles or its target is Done", () => {
    expect(
      projectDisplayStatus(
        project(),
        [],
        TODAY,
        [after({ resolvedAt: "2026-06-01T00:00:00.000Z" })],
        [project("in-play", "target")],
      ),
    ).toBe("next");
    expect(
      projectDisplayStatus(project(), [], TODAY, [after()], [
        project("done", "target"),
      ]),
    ).toBe("next");
  });

  it("returns to Waiting after the arrived Task completes", () => {
    expect(
      projectDisplayStatus(
        project(),
        [task({ completedAt: "2026-06-01T00:00:00.000Z" })],
        TODAY,
        [waiting()],
      ),
    ).toBe("waiting");
  });
});

describe("waiting helpers", () => {
  it("returns the soonest future open Task day", () => {
    expect(
      waitingUntil(
        project(),
        [
          task({ id: "a", showUpDate: "2026-09-01" }),
          task({ id: "b", showUpDate: "2026-07-15" }),
          task({
            id: "c",
            showUpDate: "2026-07-01",
            completedAt: "2026-06-01",
          }),
        ],
        TODAY,
      ),
    ).toBe("2026-07-15");
  });

  it("returns only this Project's unresolved manual conditions", () => {
    const mine = waiting({ id: "mine" });
    const resolved = waiting({ id: "resolved", resolvedAt: "2026-01-02" });
    const other = waiting({ id: "other", projectId: "other" });
    expect(
      unresolvedConditions(project(), [mine, resolved, other, after()]).map(
        (condition) => condition.id,
      ),
    ).toEqual(["mine"]);
  });

  it("uses the oldest unresolved manual condition as Waiting since", () => {
    expect(
      waitingSince(project(), [
        waiting({ id: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
        waiting({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
        after({ createdAt: "2025-01-01T00:00:00.000Z" }),
      ]),
    ).toBe("2026-01-01T00:00:00.000Z");
  });
});
