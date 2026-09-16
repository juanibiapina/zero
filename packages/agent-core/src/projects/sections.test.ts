import { describe, expect, it } from "vitest";

import type { Project, ProjectDisplayStatus, ProjectState } from "./types";
import { projectsByStatus } from "./sections";

const project = (
  id: string,
  state: ProjectState = "in-play",
  createdAt = "2023-01-01T00:00:00.000Z",
): Project => ({
  id,
  title: id,
  icon: "📁",
  description: null,
  state,
  createdAt,
});

const statusMapper = (statuses: Record<string, ProjectDisplayStatus>) =>
  (p: Project): ProjectDisplayStatus => statuses[p.id];

describe("projectsByStatus", () => {
  it("returns an empty array", () => {
    expect(projectsByStatus([], () => "next")).toEqual([]);
  });

  it("groups calculated statuses in fixed order", () => {
    const list = [
      project("b", "backlog"),
      project("a"),
      project("w"),
      project("after"),
      project("n"),
    ];
    const sections = projectsByStatus(
      list,
      statusMapper({
        b: "backlog",
        a: "active",
        w: "waiting",
        after: "after",
        n: "next",
      }),
    );
    expect(sections.map((s) => s.status)).toEqual([
      "active",
      "next",
      "waiting",
      "after",
      "backlog",
    ]);
  });

  it("omits empty sections", () => {
    const sections = projectsByStatus(
      [project("a"), project("n")],
      statusMapper({ a: "active", n: "next" }),
    );
    expect(sections.map((s) => s.status)).toEqual(["active", "next"]);
  });

  it("orders a section oldest-first", () => {
    const list = [
      project("late", "in-play", "2023-03-01T00:00:00.000Z"),
      project("early", "in-play", "2023-01-01T00:00:00.000Z"),
      project("mid", "in-play", "2023-02-01T00:00:00.000Z"),
    ];
    const sections = projectsByStatus(
      list,
      statusMapper({ late: "active", early: "active", mid: "active" }),
    );
    expect(sections[0].projects.map((p) => p.id)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });

  it("uses a supplied section sort key", () => {
    const since: Record<string, string> = {
      w1: "2023-05-01T00:00:00.000Z",
      w2: "2023-06-01T00:00:00.000Z",
    };
    const list = [
      project("w2", "in-play", "2023-02-01T00:00:00.000Z"),
      project("w1", "in-play", "2023-03-01T00:00:00.000Z"),
      project("late", "in-play", "2023-03-01T00:00:00.000Z"),
      project("early", "in-play", "2023-01-01T00:00:00.000Z"),
    ];
    const sections = projectsByStatus(
      list,
      statusMapper({ w1: "waiting", w2: "waiting", late: "active", early: "active" }),
      (p) => since[p.id] ?? p.createdAt,
    );
    expect(
      sections.find((s) => s.status === "waiting")!.projects.map((p) => p.id),
    ).toEqual(["w1", "w2"]);
    expect(
      sections.find((s) => s.status === "active")!.projects.map((p) => p.id),
    ).toEqual(["early", "late"]);
  });

  it("never emits Done", () => {
    const sections = projectsByStatus(
      [project("a"), project("d", "done")],
      statusMapper({ a: "active", d: "done" }),
    );
    expect(sections.map((s) => s.status)).toEqual(["active"]);
    expect(sections.flatMap((s) => s.projects.map((p) => p.id))).toEqual(["a"]);
  });
});
