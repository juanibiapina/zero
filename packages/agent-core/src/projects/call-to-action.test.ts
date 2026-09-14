import { describe, expect, it } from "vitest";

import { homeCallToAction } from "./call-to-action";
import type { Project, ProjectState } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

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

function task(over: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: over.id,
    text: over.text ?? over.id,
    showUpDate: over.showUpDate ?? "2026-01-01",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? null,
    sortKey: over.sortKey ?? null,
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
    expect(homeCallToAction(1, 0, [project("p")], [], TODAY)).toBeNull();
  });

  it("returns null when the inbox has captures", () => {
    expect(homeCallToAction(0, 3, [project("p")], [], TODAY)).toBeNull();
  });

  it("plans for an in-play project calculated as Next", () => {
    expect(homeCallToAction(0, 0, [project("p")], [], TODAY)).toEqual({
      kind: "plan",
      next: 1,
      waiting: 0,
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
        0,
        projects,
        [],
        TODAY,
        [freeTextCondition("w")],
      ),
    ).toEqual({ kind: "plan", next: 2, waiting: 1 });
  });

  it("activates the backlog when only Backlog and Done exist", () => {
    expect(
      homeCallToAction(
        0,
        0,
        [project("b1", "backlog"), project("b2", "backlog"), project("d", "done")],
        [],
        TODAY,
      ),
    ).toEqual({ kind: "activate-backlog", backlog: 2 });
  });

  it("asks to create with no projects or only Done projects", () => {
    expect(homeCallToAction(0, 0, [], [], TODAY)).toEqual({ kind: "create" });
    expect(
      homeCallToAction(
        0,
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
        0,
        [project("p")],
        [task({ id: "t", projectId: "p", showUpDate: "2026-01-01" })],
        TODAY,
      ),
    ).toEqual({ kind: "create" });
  });
});
