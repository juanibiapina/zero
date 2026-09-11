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
    takenOnAt: over.takenOnAt ?? null,
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

  it("parks a taken-on task in Upcoming when it is future-dated", () => {
    // Date-visibility is checked before availability: a future date parks even a
    // taken-on active-project task.
    const out = homeTasks(
      [
        task({
          id: "t",
          projectId: "p",
          takenOnAt: "2026-01-01T00:00:00.000Z",
          showUpDate: "2099-01-01",
        }),
      ],
      [project("p", "active")],
      TODAY,
    );
    expect(out).toEqual([]);
  });

  it("shows a taken-on task whose project is active", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: "2026-01-01T00:00:00.000Z" })],
      [project("p", "active")],
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["t"]);
  });

  it("hides a parked task even when its project is active", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: null })],
      [project("p", "active")],
      TODAY,
    );
    expect(out).toEqual([]);
  });

  it("shows a taken-on task even when its project has an unresolved condition", () => {
    // Taking a task on overrides waiting: the project displays active again, so
    // the task shows.
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: "2026-01-02T00:00:00.000Z" })],
      [project("p", "active")],
      TODAY,
      [freeTextCondition("p")],
    );
    expect(out.map((t) => t.id)).toEqual(["t"]);
  });

  it("hides a parked task on a project with an unresolved condition (waiting)", () => {
    const out = homeTasks(
      [task({ id: "t", projectId: "p", takenOnAt: null })],
      [project("p", "next")],
      TODAY,
      [freeTextCondition("p")],
    );
    expect(out).toEqual([]);
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
      TODAY,
    );
    expect(out.map((t) => t.id)).toEqual(["loose"]);
  });

  it("hides a task whose project is missing (deleted/not loaded)", () => {
    const out = homeTasks([task({ id: "t", projectId: "gone" })], [], TODAY);
    expect(out).toEqual([]);
  });
});
