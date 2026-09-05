import { describe, expect, it } from "vitest";

import { projectDisplayStatus } from "./derive";
import type { Project, ProjectStatus } from "./types";
import type { Task } from "../tasks/types";

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
});
