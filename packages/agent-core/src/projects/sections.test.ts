import { describe, expect, it } from "vitest";
import type { Task } from "../taskdo/types";
import type { WaitingCondition } from "../taskdo/types";
import { projectStatusSections } from "./sections";
import type { Project, ProjectState } from "./types";

const today = "2026-09-24";
const project = (id: string, state: ProjectState = "in-play", createdAt = "2023-01-01"): Project => ({
  id, title: id, icon: "📁", description: null, state, createdAt,
});
const task = (projectId: string, showUpDate: string): Task => ({
  id: `${projectId}-task`, text: "Work", projectId, showUpDate,
  recurrence: null, recurrenceDate: null,
  createdAt: "2023-01-01", completedAt: null, sortKey: null,
});
const wait = (projectId: string, createdAt: string): WaitingCondition => ({
  id: `${projectId}-wait`, projectId, kind: "free-text", text: "Reply",
  refId: null, targetStatus: null, createdAt, resolvedAt: null,
});
const after = (projectId: string, refId: string, createdAt = "2023-01-01"): WaitingCondition => ({
  id: `${projectId}-after`, projectId, kind: "project-status", text: null,
  refId, targetStatus: "done", createdAt, resolvedAt: null,
});
const sections = (projects: Project[], tasks: Task[] = [], conditions: WaitingCondition[] = []) =>
  projectStatusSections({ projects, tasks, conditions, today });

describe("projectStatusSections", () => {
  it("omits empty sections and Done projects", () => {
    expect(sections([])).toEqual([]);
    expect(sections([project("next"), project("done", "done")]).map((s) => s.status)).toEqual(["next"]);
  });

  it("orders Active, Next, Waiting, After, Backlog and uses the full attention snapshot", () => {
    const projects = [project("backlog", "backlog"), project("next"), project("after"),
      project("target"), project("waiting"), project("active"), project("done", "done")];
    const grouped = sections(projects, [task("active", today), task("waiting", "2026-09-26")],
      [after("after", "target")]);
    expect(grouped.map((section) => section.status)).toEqual(["active", "next", "waiting", "after", "backlog"]);
    expect(grouped.flatMap((section) => section.projects.map((p) => p.id))).not.toContain("done");
    expect(grouped.find((section) => section.status === "after")?.collapsed).toBe(true);
  });

  it("sorts sections oldest-first, manual waits before date waits, and After by relationship age", () => {
    const projects = [project("new"), project("dated"), project("old"),
      project("after-new"), project("target"), project("after-old")];
    const grouped = sections(projects, [task("dated", "2026-09-26")], [
      wait("new", "2026-09-20"), wait("old", "2026-09-01"),
      after("after-new", "target", "2026-09-20"), after("after-old", "target", "2026-09-01"),
    ]);
    expect(grouped.find((s) => s.status === "waiting")?.projects.map((p) => p.id)).toEqual(["old", "new", "dated"]);
    expect(grouped.find((s) => s.status === "after")?.projects.map((p) => p.id)).toEqual(["after-old", "after-new"]);
    expect(sections([project("late", "in-play", "2023-02-01"), project("early")])[0].projects.map((p) => p.id))
      .toEqual(["early", "late"]);
  });

  it("uses mobile's reactive fold defaults until the user toggles a section", () => {
    const five = Array.from({ length: 5 }, (_, i) => project(`backlog ${i}`, "backlog"));
    const six = [...five, project("backlog 5", "backlog")];
    expect(sections(five)[0].collapsed).toBe(false);
    expect(sections(six)[0].collapsed).toBe(true);
    expect(projectStatusSections({ projects: six, tasks: [], conditions: [], today,
      collapseOverride: { backlog: false } })[0].collapsed).toBe(false);
  });

  it("reveals folded matches during search without changing the manual fold", () => {
    const projects = Array.from({ length: 6 }, (_, i) => project(`backlog ${i}`, "backlog"));
    const options = { projects, tasks: [], conditions: [], today, collapseOverride: { backlog: true } };
    const filtered = projectStatusSections({ ...options, filter: " BACKLOG 5 " });
    expect(filtered.map((s) => [s.status, s.count, s.collapsed, s.projects[0].id]))
      .toEqual([["backlog", 1, false, "backlog 5"]]);
    expect(projectStatusSections(options)[0].collapsed).toBe(true);
    expect(projectStatusSections({ ...options, filter: "missing" })).toEqual([]);
  });

  it("limits After targets but derives their status against every Project", () => {
    const projects = [project("source"), project("target"), project("after"),
      project("backlog", "backlog"), project("done", "done")];
    const conditions = [after("source", "target"), after("after", "source")];
    const choice = (tasks: Task[]) => projectStatusSections({ projects, tasks, conditions, today,
      afterSourceProjectId: "source" });
    expect(choice([]).flatMap((s) => s.projects.map((p) => p.id))).toEqual(["backlog"]);
    // A different source can choose the After Project. Its status depends on
    // the source relationship, which points outside the eligible target set.
    const other = projectStatusSections({ projects, tasks: [], conditions, today,
      afterSourceProjectId: "backlog" });
    expect(other.find((s) => s.status === "after")?.projects.map((p) => p.id)).toEqual(["source", "after"]);
    expect(projectStatusSections({ projects, tasks: [task("after", today)], conditions, today,
      afterSourceProjectId: "backlog" }).find((s) => s.status === "active")?.projects.map((p) => p.id))
      .toEqual(["after"]);
  });
});
