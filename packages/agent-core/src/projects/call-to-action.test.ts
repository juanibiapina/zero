import { describe, expect, it } from "vitest";
import { projectParent } from "../tasks/parent";

import { homeCallToAction } from "./call-to-action";
import type { Project, ProjectState } from "./types";
import type { Task } from "../taskdo/types";
import type { WaitingCondition } from "../taskdo/types";

const TODAY = "2026-06-01";

function project(id: string, state: ProjectState = "in-play"): Project {
  return {
    id,
    title: id,
    icon: "📁",
    description: null,
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(over: Partial<Task> & Pick<Task, "id"> & { projectId?: string | null }): Task {
  return {
    id: over.id,
    text: over.text ?? over.id,
    showUpDate: over.showUpDate ?? "2026-01-01",
    recurrence: over.recurrence ?? null,
    recurrenceDate: over.recurrenceDate ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    parent: projectParent(over.projectId),
    sortKey: over.sortKey ?? null,
  };
}

function projectDependency(
  projectId: string,
  refId: string,
): WaitingCondition {
  return {
    id: `${projectId}-${refId}`,
    projectId,
    kind: "project-status",
    text: null,
    refId,
    targetStatus: "done",
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function freeTextCondition(projectId: string): WaitingCondition {
  return {
    id: "c",
    projectId,
    kind: "free-text",
    text: "the letter comes back",
    refId: null,
    targetStatus: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("homeCallToAction", () => {
  it("returns null when the plate has tasks", () => {
    expect(homeCallToAction(1, [project("p")], [], TODAY)).toBeNull();
  });

  it("plans for an in-play project calculated as Next", () => {
    expect(homeCallToAction(0, [project("p")], [], TODAY)).toEqual({
      kind: "plan",
      next: 1,
      waiting: 0,
      after: 0,
    });
  });

  it("counts calculated Next and Waiting projects", () => {
    const projects = [
      project("n1"),
      project("n2"),
      project("w"),
      project("b", "backlog"),
    ];
    expect(
      homeCallToAction(
        0,
        projects,
        [],
        TODAY,
        [freeTextCondition("w")],
      ),
    ).toEqual({ kind: "plan", next: 2, waiting: 1, after: 0 });
  });

  it("counts After in a mixed plan and stays quiet when every In-play Project is After", () => {
    const mixed = [project("next"), project("after"), project("prerequisite")];
    expect(
      homeCallToAction(
        0,
        mixed,
        [],
        TODAY,
        [projectDependency("after", "prerequisite")],
      ),
    ).toEqual({ kind: "plan", next: 2, waiting: 0, after: 1 });

    const allAfter = [project("a"), project("b"), project("prerequisite")];
    expect(
      homeCallToAction(
        0,
        allAfter,
        [],
        TODAY,
        [
          projectDependency("a", "prerequisite"),
          projectDependency("b", "prerequisite"),
          projectDependency("prerequisite", "missing"),
        ],
      ),
    ).toEqual({ kind: "after", after: 3 });
  });

  it("activates the backlog when only Backlog and Done exist", () => {
    expect(
      homeCallToAction(
        0,
        [project("b1", "backlog"), project("b2", "backlog"), project("d", "done")],
        [],
        TODAY,
      ),
    ).toEqual({ kind: "activate-backlog", backlog: 2 });
  });

  it("asks to create with no projects or only Done projects", () => {
    expect(homeCallToAction(0, [], [], TODAY)).toEqual({ kind: "create" });
    expect(
      homeCallToAction(
        0,
        [project("d1", "done"), project("d2", "done")],
        [],
        TODAY,
      ),
    ).toEqual({ kind: "create" });
  });

  it("does not count an in-play project calculated as Active", () => {
    expect(
      homeCallToAction(
        0,
        [project("p")],
        [task({ id: "t", projectId: "p", showUpDate: "2026-01-01" })],
        TODAY,
      ),
    ).toEqual({ kind: "create" });
  });
});
