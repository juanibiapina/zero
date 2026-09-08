import { describe, expect, it } from "vitest";

import {
  conditionSatisfied,
  projectDisplayStatus,
  unresolvedConditions,
} from "./derive";
import type { Project, ProjectStatus } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

function condition(over: Partial<WaitingCondition>): WaitingCondition {
  return {
    id: over.id ?? "c",
    projectId: over.projectId ?? "p",
    kind: over.kind ?? "free-text",
    text: over.text ?? null,
    refId: over.refId ?? null,
    targetStatus: over.targetStatus ?? null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
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
    showUpDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? "p",
    takenOnAt: over.takenOnAt ?? null,
  };
}

describe("projectDisplayStatus", () => {
  it("keeps backlog and done from the stored value", () => {
    expect(projectDisplayStatus(project("backlog"), [])).toBe("backlog");
    expect(projectDisplayStatus(project("done"), [])).toBe("done");
  });

  it("is next when in play with no taken-on task", () => {
    expect(projectDisplayStatus(project("next"), [])).toBe("next");
    expect(
      projectDisplayStatus(project("next"), [task({ takenOnAt: null })]),
    ).toBe("next");
  });

  it("is active when in play with a taken-on open task", () => {
    expect(
      projectDisplayStatus(project("next"), [
        task({ takenOnAt: "2026-01-02T00:00:00.000Z" }),
      ]),
    ).toBe("active");
  });

  it("ignores a completed taken-on task (drops back to next)", () => {
    expect(
      projectDisplayStatus(project("active"), [
        task({
          takenOnAt: "2026-01-02T00:00:00.000Z",
          completedAt: "2026-01-03T00:00:00.000Z",
        }),
      ]),
    ).toBe("next");
  });

  it("ignores tasks of other projects", () => {
    expect(
      projectDisplayStatus(project("next"), [
        task({ projectId: "other", takenOnAt: "2026-01-02T00:00:00.000Z" }),
      ]),
    ).toBe("next");
  });

  it("is waiting when an unresolved condition exists and nothing is taken on", () => {
    expect(
      projectDisplayStatus(project("next"), [], [condition({})]),
    ).toBe("waiting");
  });

  it("a taken-on open task overrides an unresolved condition (active, not waiting)", () => {
    const taken = task({ takenOnAt: "2026-01-02T00:00:00.000Z" });
    expect(
      projectDisplayStatus(project("next"), [taken], [condition({})]),
    ).toBe("active");
  });

  it("drops back to waiting (not next) when the taken-on task is completed", () => {
    const done = task({
      takenOnAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(
      projectDisplayStatus(project("next"), [done], [condition({})]),
    ).toBe("waiting");
  });

  it("leaves waiting once the condition resolves", () => {
    expect(
      projectDisplayStatus(
        project("next"),
        [],
        [condition({ resolvedAt: "2026-01-03T00:00:00.000Z" })],
      ),
    ).toBe("next");
  });
});

describe("conditionSatisfied", () => {
  it("free-text: satisfied only when resolvedAt is set", () => {
    expect(conditionSatisfied(condition({}), [], [])).toBe(false);
    expect(
      conditionSatisfied(condition({ resolvedAt: "2026-01-03" }), [], []),
    ).toBe(true);
  });

  it("task-done: satisfied when the referenced task is completed", () => {
    const c = condition({ kind: "task-done", refId: "t1" });
    expect(conditionSatisfied(c, [task({ id: "t1" })], [])).toBe(false);
    expect(
      conditionSatisfied(c, [task({ id: "t1", completedAt: "2026-01-03" })], []),
    ).toBe(true);
  });

  it("project-status: satisfied when the referenced project reaches the target", () => {
    const c = condition({
      kind: "project-status",
      refId: "x",
      targetStatus: "done",
    });
    const other = { ...project("done"), id: "x" };
    expect(conditionSatisfied(c, [], [other])).toBe(true);
    const notYet = { ...project("next"), id: "x" };
    expect(conditionSatisfied(c, [], [notYet])).toBe(false);
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
    const out = unresolvedConditions(p, [mine, resolved, other], [], []);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});
