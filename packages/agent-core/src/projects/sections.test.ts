import { describe, expect, it } from "vitest";

import type { Project, ProjectStatus } from "./types";
import { projectsByStatus } from "./sections";

const project = (
  id: string,
  status: ProjectStatus,
  createdAt = "2023-01-01T00:00:00.000Z",
): Project => ({
  id,
  title: id,
  icon: "📁",
  description: null,
  status,
  createdAt,
});

describe("projectsByStatus", () => {
  it("returns an empty array for an empty list", () => {
    expect(projectsByStatus([])).toEqual([]);
  });

  it("groups into sections in the fixed Active/Next/Waiting/Backlog order", () => {
    const sections = projectsByStatus([
      project("b", "backlog"),
      project("a", "active"),
      project("w", "waiting"),
      project("n", "next"),
    ]);
    expect(sections.map((s) => s.status)).toEqual([
      "active",
      "next",
      "waiting",
      "backlog",
    ]);
  });

  it("omits empty sections", () => {
    const sections = projectsByStatus([
      project("a", "active"),
      project("n", "next"),
    ]);
    expect(sections.map((s) => s.status)).toEqual(["active", "next"]);
  });

  it("orders projects within a section oldest-first", () => {
    const sections = projectsByStatus([
      project("late", "active", "2023-03-01T00:00:00.000Z"),
      project("early", "active", "2023-01-01T00:00:00.000Z"),
      project("mid", "active", "2023-02-01T00:00:00.000Z"),
    ]);
    expect(sections[0].projects.map((p) => p.id)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });

  it("orders a section by a supplied sortKey, leaving others on createdAt", () => {
    // waitingSince-style key: waiting projects sort by a blocked-since instant,
    // others fall back to createdAt.
    const since: Record<string, string> = {
      w1: "2023-05-01T00:00:00.000Z", // waited longest (oldest since)
      w2: "2023-06-01T00:00:00.000Z",
    };
    const sections = projectsByStatus(
      [
        project("w2", "waiting", "2023-02-01T00:00:00.000Z"),
        project("w1", "waiting", "2023-03-01T00:00:00.000Z"),
        project("late", "active", "2023-03-01T00:00:00.000Z"),
        project("early", "active", "2023-01-01T00:00:00.000Z"),
      ],
      (p) => p.status,
      (p) => since[p.id] ?? p.createdAt,
    );
    const waiting = sections.find((s) => s.status === "waiting")!;
    // Oldest since first: w1 then w2 (not their createdAt order).
    expect(waiting.projects.map((p) => p.id)).toEqual(["w1", "w2"]);
    const active = sections.find((s) => s.status === "active")!;
    // No override for active rows, so they keep createdAt order.
    expect(active.projects.map((p) => p.id)).toEqual(["early", "late"]);
  });

  it("never emits a done section", () => {
    const sections = projectsByStatus([
      project("a", "active"),
      project("d", "done"),
    ]);
    expect(sections.map((s) => s.status)).toEqual(["active"]);
    expect(sections.flatMap((s) => s.projects.map((p) => p.id))).toEqual(["a"]);
  });
});
