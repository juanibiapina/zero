import { describe, expect, it } from "vitest";

import {
  candidatePrerequisiteProjects,
  dependentProjectsForPrerequisite,
  isProjectCompletionDependency,
  projectDependencies,
  projectDependencyContext,
  projectDependencyRemovalImpact,
  projectDependencyRemovalWarning,
  unresolvedProjectDependencies,
  wouldCreateProjectDependencyCycle,
} from "./dependencies";
import type { WaitingCondition } from "../waits/types";
import type { Project } from "./types";

function condition(over: Partial<WaitingCondition> = {}): WaitingCondition {
  return {
    id: over.id ?? "dependency",
    projectId: over.projectId ?? "dependent",
    kind: over.kind ?? "project-status",
    text: over.text ?? null,
    refId: over.refId !== undefined ? over.refId : "prerequisite",
    targetStatus: over.targetStatus ?? "done",
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function project(id: string, state: Project["state"] = "in-play"): Project {
  return {
    id,
    title: id,
    icon: "📁",
    description: null,
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("project completion dependencies", () => {
  it("recognizes only project-status conditions targeting Done", () => {
    expect(isProjectCompletionDependency(condition())).toBe(true);
    expect(
      isProjectCompletionDependency(condition({ kind: "task-done" })),
    ).toBe(false);
    expect(
      isProjectCompletionDependency(condition({ targetStatus: "active" })),
    ).toBe(false);
    expect(isProjectCompletionDependency(condition({ refId: null }))).toBe(false);
  });

  it("returns only open dependencies whose prerequisite is not Done", () => {
    const open = condition({ id: "open", refId: "open-project" });
    const consumed = condition({
      id: "consumed",
      refId: "other-project",
      resolvedAt: "2026-02-01T00:00:00.000Z",
    });
    const optimisticallyDone = condition({ id: "done", refId: "done-project" });
    const ordinary = condition({ id: "ordinary", kind: "free-text" });

    expect(
      unresolvedProjectDependencies(
        "dependent",
        [open, consumed, optimisticallyDone, ordinary],
        [project("open-project"), project("done-project", "done")],
      ).map((dependency) => dependency.id),
    ).toEqual(["open"]);
  });

  it("detects direct and transitive cycles", () => {
    const edges = [
      condition({ id: "b-to-c", projectId: "b", refId: "c" }),
      condition({ id: "c-to-a", projectId: "c", refId: "a" }),
    ];

    expect(wouldCreateProjectDependencyCycle("a", "a", edges)).toBe(true);
    expect(wouldCreateProjectDependencyCycle("a", "c", edges)).toBe(true);
    expect(wouldCreateProjectDependencyCycle("a", "b", edges)).toBe(true);
    expect(wouldCreateProjectDependencyCycle("a", "d", edges)).toBe(false);
  });

  it("returns only projects that can be added as prerequisites", () => {
    const edges = [
      condition({ id: "existing", projectId: "a", refId: "b" }),
      condition({ id: "cycle", projectId: "c", refId: "a" }),
    ];
    const candidates = candidatePrerequisiteProjects(
      "a",
      [
        project("a"),
        project("b"),
        project("c"),
        project("d", "done"),
        project("e", "backlog"),
      ],
      edges,
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual(["e"]);
  });

  it("resolves prerequisite identities and summarizes one or several dependencies", () => {
    const first = condition({
      id: "first",
      refId: "house",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = condition({
      id: "second",
      refId: "missing",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const house = { ...project("house"), title: "Sell old house", icon: "🏠" };

    expect(projectDependencies("dependent", [first], [house])).toEqual([
      { condition: first, prerequisite: house },
    ]);
    expect(projectDependencyContext("dependent", [first], [house])).toEqual({
      label: "after 🏠 Sell old house",
      sortKey: "2026-01-01T00:00:00.000Z",
    });
    expect(
      projectDependencyContext("dependent", [second], [house])?.label,
    ).toBe("after another project");
    expect(
      projectDependencyContext("dependent", [second, first], [house]),
    ).toEqual({
      label: "after 2 projects",
      sortKey: "2026-01-01T00:00:00.000Z",
    });
  });

  it("finds projects that an open prerequisite deletion would unblock", () => {
    const projects = [project("a"), project("b"), project("other")];
    const conditions = [
      condition({ id: "a-to-target", projectId: "a", refId: "target" }),
      condition({ id: "b-to-target", projectId: "b", refId: "target" }),
      condition({ id: "other", projectId: "other", refId: "elsewhere" }),
      condition({
        id: "resolved",
        projectId: "other",
        refId: "target",
        resolvedAt: "2026-03-01T00:00:00.000Z",
      }),
    ];

    expect(
      dependentProjectsForPrerequisite("target", conditions, projects).map(
        (dependent) => dependent.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("distinguishes affected projects from projects whose final dependency is removed", () => {
    const projects = [project("a"), project("b"), project("other-prerequisite")];
    const conditions = [
      condition({ id: "a-to-target", projectId: "a", refId: "target" }),
      condition({ id: "b-to-target", projectId: "b", refId: "target" }),
      condition({
        id: "b-to-other",
        projectId: "b",
        refId: "other-prerequisite",
      }),
    ];

    const impact = projectDependencyRemovalImpact(
      "target",
      conditions,
      projects,
    );
    expect(impact).toEqual({
      affectedProjects: [projects[0], projects[1]],
      unblockedProjects: [projects[0]],
    });
    expect(projectDependencyRemovalWarning(impact)).toBe(
      "This removes dependencies from 2 projects; 1 will be unblocked.",
    );
    expect(
      projectDependencyRemovalWarning({
        affectedProjects: [projects[0]],
        unblockedProjects: [projects[0]],
      }),
    ).toBe("“a” depends on it and will be unblocked.");
  });
});
