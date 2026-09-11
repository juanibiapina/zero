import { describe, expect, it } from "vitest";

import { homeCallToAction } from "./call-to-action";

const TODAY = "2026-06-01";
import type { Project, ProjectStatus } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

function project(id: string, status: ProjectStatus): Project {
  return {
    id,
    title: id,
    icon: "📁",
    description: null,
    status,
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
    takenOnAt: over.takenOnAt ?? null,
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
    expect(homeCallToAction(1, 0, [project("p", "next")], [], TODAY)).toBeNull();
  });

  it("returns null when the plate is empty but the inbox has captures", () => {
    expect(homeCallToAction(0, 3, [project("p", "next")], [], TODAY)).toBeNull();
  });

  it("plans when the plate and inbox are empty and a project is next", () => {
    expect(homeCallToAction(0, 0, [project("p", "next")], [], TODAY)).toEqual({
      kind: "plan",
      next: 1,
      waiting: 0,
    });
  });

  it("counts next and waiting projects by derived status", () => {
    const projects = [
      project("n1", "next"),
      project("n2", "next"),
      project("w", "next"), // becomes waiting via its condition below
      project("b", "backlog"),
    ];
    const out = homeCallToAction(
      0,
      0,
      projects,
      [],
      TODAY,
      [freeTextCondition("w")],
    );
    expect(out).toEqual({ kind: "plan", next: 2, waiting: 1 });
  });

  it("activates the backlog when only backlog/done projects exist", () => {
    const out = homeCallToAction(0, 0, [
      project("b1", "backlog"),
      project("b2", "backlog"),
      project("d", "done"),
    ], [], TODAY);
    expect(out).toEqual({ kind: "activate-backlog", backlog: 2 });
  });

  it("asks to create when there are no projects", () => {
    expect(homeCallToAction(0, 0, [], [], TODAY)).toEqual({ kind: "create" });
  });

  it("asks to create when every project is done", () => {
    const out = homeCallToAction(0, 0, [
      project("d1", "done"),
      project("d2", "done"),
    ], [], TODAY);
    expect(out).toEqual({ kind: "create" });
  });

  it("uses the derived status: a project with a taken-on open task is active, not counted", () => {
    // `p` has a taken-on open task, so its display status is `active` and it is
    // excluded from the working next/waiting/backlog counts. (The plate would not
    // really be empty here, but the helper is gated on plateCount, which the
    // caller supplies — this asserts the derivation, given plateCount 0.)
    const out = homeCallToAction(
      0,
      0,
      [project("p", "next")],
      [task({ id: "t", projectId: "p", takenOnAt: "2026-01-02T00:00:00.000Z" })],
      TODAY,
    );
    expect(out).toEqual({ kind: "create" });
  });
});
