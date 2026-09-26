import { describe, expect, it } from "vitest";

import {
  candidateAfterProjects,
  isProjectAfter,
  projectAfters,
  projectAfterContext,
  projectAfterRemovalImpact,
  projectAfterRemovalWarning,
  projectsAfterTarget,
  unresolvedProjectAfters,
  wouldCreateAfterCycle,
} from "./afters";
import type { ProjectAfter, ProjectAttention } from "../taskdo/types";
import type { Project } from "./types";

function after(over: Partial<ProjectAfter> = {}): ProjectAfter {
  return {
    id: over.id ?? "relationship",
    projectId: over.projectId ?? "source",
    kind: "project-status",
    text: null,
    refId: over.refId ?? "target",
    targetStatus: "done",
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

describe("Project After relationships", () => {
  it("recognizes only the Project-completion variant", () => {
    expect(isProjectAfter(after())).toBe(true);
    const waiting: ProjectAttention = {
      id: "wait",
      projectId: "source",
      kind: "free-text",
      text: "a reply",
      refId: null,
      targetStatus: null,
      resolvedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isProjectAfter(waiting)).toBe(false);
  });

  it("returns only open relationships whose target is not Done", () => {
    const open = after({ id: "open", refId: "open-project" });
    const settled = after({
      id: "settled",
      refId: "other-project",
      resolvedAt: "2026-02-01T00:00:00.000Z",
    });
    const optimisticallyDone = after({ id: "done", refId: "done-project" });

    expect(
      unresolvedProjectAfters(
        "source",
        [open, settled, optimisticallyDone],
        [project("open-project"), project("done-project", "done")],
      ).map((relationship) => relationship.id),
    ).toEqual(["open"]);
  });

  it("detects direct and transitive cycles", () => {
    const relationships = [
      after({ id: "b-to-c", projectId: "b", refId: "c" }),
      after({ id: "c-to-a", projectId: "c", refId: "a" }),
    ];

    expect(wouldCreateAfterCycle("a", "a", relationships)).toBe(true);
    expect(wouldCreateAfterCycle("a", "c", relationships)).toBe(true);
    expect(wouldCreateAfterCycle("a", "b", relationships)).toBe(true);
    expect(wouldCreateAfterCycle("a", "d", relationships)).toBe(false);
  });

  it("returns only Projects that can be selected", () => {
    const relationships = [
      after({ id: "existing", projectId: "a", refId: "b" }),
      after({ id: "cycle", projectId: "c", refId: "a" }),
    ];
    expect(
      candidateAfterProjects(
        "a",
        [
          project("a"),
          project("b"),
          project("c"),
          project("d", "done"),
          project("e", "backlog"),
        ],
        relationships,
      ).map((candidate) => candidate.id),
    ).toEqual(["e"]);
  });

  it("resolves target identities and supplies detail and row grammar", () => {
    const first = after({
      id: "first",
      refId: "house",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = after({
      id: "second",
      refId: "missing",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const house = { ...project("house"), title: "Buy a house", icon: "🏠" };

    expect(projectAfters("source", [first], [house])).toEqual([
      { relationship: first, target: house },
    ]);
    expect(projectAfterContext("source", [first], [house])).toEqual({
      detailLabel: "🏠 Buy a house",
      rowLabel: "after 🏠 Buy a house",
      sortKey: "2026-01-01T00:00:00.000Z",
    });
    expect(projectAfterContext("source", [second], [house])?.rowLabel).toBe(
      "after another project",
    );
    expect(projectAfterContext("source", [second, first], [house])).toEqual({
      detailLabel: "2 projects",
      rowLabel: "after 2 projects",
      sortKey: "2026-01-01T00:00:00.000Z",
    });
  });

  it("describes Projects affected by deleting an After target", () => {
    const projects = [project("a"), project("b"), project("other")];
    const conditions = [
      after({ id: "a-to-target", projectId: "a", refId: "target" }),
      after({ id: "b-to-target", projectId: "b", refId: "target" }),
      after({ id: "other", projectId: "other", refId: "elsewhere" }),
    ];

    expect(
      projectsAfterTarget("target", conditions, projects).map(
        (source) => source.id,
      ),
    ).toEqual(["a", "b"]);
    const impact = projectAfterRemovalImpact("target", conditions, projects);
    expect(projectAfterRemovalWarning(impact)).toBe(
      "2 projects are after it and may move to another section.",
    );
    expect(
      projectAfterRemovalWarning({ affectedProjects: [projects[0]] }),
    ).toBe("“a” is after it and may move to another section.");
  });
});
