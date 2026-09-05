import { describe, expect, it } from "vitest";

import { homeTasks } from "./home";
import type { Task } from "./types";
import type { Project } from "../projects/types";

function task(over: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: over.id,
    text: over.text ?? over.id,
    showUpDate: over.showUpDate ?? "2026-01-01",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? null,
    takenOnAt: over.takenOnAt ?? null,
  };
}

function project(id: string, status: Project["status"]): Project {
  return {
    id,
    title: id,
    icon: "📁",
    description: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("homeTasks", () => {
  it("returns open tasks oldest-first", () => {
    const out = homeTasks(
      [
        task({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
        task({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
      [],
    );
    expect(out.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes completed tasks", () => {
    const out = homeTasks(
      [
        task({ id: "open" }),
        task({ id: "done", completedAt: "2026-01-02T00:00:00.000Z" }),
      ],
      [],
    );
    expect(out.map((t) => t.id)).toEqual(["open"]);
  });

  it("always shows loose tasks", () => {
    const out = homeTasks([task({ id: "loose", projectId: null })], []);
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("shows a taken-on task whose project is active", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: "2026-01-01T00:00:00.000Z" })],
      [project("p", "active")],
    );
    expect(out.map((t) => t.id)).toEqual(["t"]);
  });

  it("hides a parked task even when its project is active", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: null })],
      [project("p", "active")],
    );
    expect(out).toEqual([]);
  });

  it("shows a loose task regardless of takenOnAt", () => {
    const out = homeTasks(
      [task({ id: "loose", projectId: null, takenOnAt: null })],
      [],
    );
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("hides a task whose project is not active", () => {
    const projects = [
      project("next", "next"),
      project("waiting", "waiting"),
      project("backlog", "backlog"),
    ];
    const out = homeTasks(
      [
        task({ id: "n", projectId: "next" }),
        task({ id: "w", projectId: "waiting" }),
        task({ id: "b", projectId: "backlog" }),
        task({ id: "loose", projectId: null }),
      ],
      projects,
    );
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("hides a task whose project is missing (deleted/not loaded)", () => {
    const out = homeTasks([task({ id: "t", projectId: "gone" })], []);
    expect(out).toEqual([]);
  });

  it("ignores showUpDate (availability, not date, gates the list)", () => {
    const out = homeTasks(
      [
        task({ id: "future", showUpDate: "2099-01-01" }),
        task({ id: "past", showUpDate: "2000-01-01" }),
      ],
      [],
    );
    expect(out.map((t) => t.id).sort()).toEqual(["future", "past"]);
  });
});
