import { describe, expect, it } from "vitest";

import { homeTasks } from "./home";
import type { Task } from "./types";
import type { Project } from "../projects/types";
import type { WaitingCondition } from "../waits/types";

// The default task's showUpDate; TODAY is a day after it so it is "shown up".
const TODAY = "2026-01-02";

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

function task(over: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: over.id,
    text: over.text ?? over.id,
    showUpDate: over.showUpDate === undefined ? "2026-01-01" : over.showUpDate,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? null,
    sortKey: over.sortKey ?? null,
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
  it("orders unkeyed tasks oldest-first (createdAt tiebreak)", () => {
    const out = homeTasks(
      [
        task({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
        task({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("orders by the manual sort key when present (nulls last)", () => {
    const out = homeTasks(
      [
        task({ id: "unkeyed" }),
        task({ id: "second", sortKey: "a1" }),
        task({ id: "first", sortKey: "a0" }),
      ],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["first", "second", "unkeyed"]);
  });

  it("excludes completed tasks", () => {
    const out = homeTasks(
      [
        task({ id: "open" }),
        task({ id: "done", completedAt: "2026-01-02T00:00:00.000Z" }),
      ],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["open"]);
  });

  it("always shows loose tasks (null showUpDate too)", () => {
    const out = homeTasks(
      [task({ id: "loose", projectId: null, showUpDate: null })],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("hides a future-dated task (it belongs to Upcoming)", () => {
    const out = homeTasks(
      [
        task({ id: "future", showUpDate: "2099-01-01" }),
        task({ id: "shown", showUpDate: "2026-01-01" }),
      ],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["shown"]);
  });

  it("rolls an overdue task into Home (showUpDate before today)", () => {
    const out = homeTasks(
      [task({ id: "overdue", showUpDate: "2000-01-01" })],
      [],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["overdue"]);
  });

  it("hides a future-dated project task (it belongs to Upcoming)", () => {
    // A project task needs an arrived date; a future date parks it in Upcoming.
    const out = homeTasks(
      [task({ id: "t", projectId: "p", showUpDate: "2099-01-01" })],
      [project("p", "active")],
      TODAY,
    );
    expect(out).toEqual([]);
  });

  it("shows a project task whose arrived date makes its project active", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", showUpDate: "2026-01-01" })],
      [project("p", "next")],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["t"]);
  });

  it("hides an undated (groomed) project task even alongside a dated one", () => {
    // The dated task makes the project active; the undated task is groomed and
    // stays on the project screen only (the loose/project null-date asymmetry).
    const out = homeTasks(
      [
        task({ id: "dated", projectId: "p", showUpDate: "2026-01-01" }),
        task({ id: "groomed", projectId: "p", showUpDate: null }),
      ],
      [project("p", "next")],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["dated"]);
  });

  it("shows a dated project task even when its project has an unresolved condition", () => {
    // Dating a task overrides waiting: the project displays active again, so the
    // task shows.
    const out = homeTasks(
      [task({ id: "t", projectId: "p", showUpDate: "2026-01-01" })],
      [project("p", "next")],
      TODAY,
      [freeTextCondition("p")],
    );
    expect(out.map((t) => t.id)).toEqual(["t"]);
  });

  it("hides an undated project task on a project with an unresolved condition (waiting)", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", showUpDate: null })],
      [project("p", "next")],
      TODAY,
      [freeTextCondition("p")],
    );
    expect(out).toEqual([]);
  });

  it("hides a dated project task under a backlog or done project", () => {
    const projects = [
      project("backlog", "backlog"),
      project("done", "done"),
    ];
    const out = homeTasks(
      [
        task({ id: "b", projectId: "backlog", showUpDate: "2026-01-01" }),
        task({ id: "d", projectId: "done", showUpDate: "2026-01-01" }),
        task({ id: "loose", projectId: null }),
      ],
      projects,
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("hides a task whose project is missing (deleted/not loaded)", () => {
    const out = homeTasks([task({ id: "t", projectId: "gone" })], [], TODAY);
    expect(out).toEqual([]);
  });
});
