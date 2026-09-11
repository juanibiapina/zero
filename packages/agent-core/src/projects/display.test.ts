import { describe, expect, it } from "vitest";

import type { Project } from "./types";
import type { Task } from "../tasks/types";
import { DEFAULT_ICON, taskIcon } from "./display";

const project = (over: Partial<Project> & { id: string }): Project => ({
  title: "Project",
  icon: "🎓",
  description: null,
  status: "next",
  createdAt: "2023-01-01T00:00:00.000Z",
  ...over,
});

const task = (over: Partial<Task> & { id: string }): Task => ({
  text: "task",
  showUpDate: null,
  createdAt: "2023-01-01T00:00:00.000Z",
  completedAt: null,
  projectId: null,
  takenOnAt: null,
  sortKey: null,
  ...over,
});

describe("taskIcon", () => {
  it("returns null for a loose task", () => {
    expect(taskIcon(task({ id: "1" }), [])).toBeNull();
  });

  it("returns the project's icon for a project task", () => {
    const p = project({ id: "p", icon: "🎓" });
    expect(taskIcon(task({ id: "1", projectId: "p" }), [p])).toBe("🎓");
  });

  it("falls back to DEFAULT_ICON when the project is not in the list", () => {
    expect(taskIcon(task({ id: "1", projectId: "gone" }), [])).toBe(
      DEFAULT_ICON,
    );
  });
});
