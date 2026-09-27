import { describe, expect, it } from "vitest";

import { upcomingSections } from "./upcoming";
import type { Task } from "../taskdo/types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  showUpDate: null,
  recurrence: null,
  recurrenceDate: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
  projectId: null,
  sortKey: null,
  ...over,
});

describe("upcomingSections", () => {
  const today = "2024-01-10";

  it("groups only future-dated open tasks, days ascending", () => {
    const sections = upcomingSections(
      [
        task("today", { showUpDate: "2024-01-10" }),
        task("overdue", { showUpDate: "2024-01-01" }),
        task("loose", { showUpDate: null }),
        task("t1", { showUpDate: "2024-01-12" }),
        task("t0", { showUpDate: "2024-01-11" }),
        task("t1b", { showUpDate: "2024-01-12" }),
      ],
      today,
    );
    expect(sections.map((s) => s.date)).toEqual(["2024-01-11", "2024-01-12"]);
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["t0"]);
    expect(sections[1].tasks.map((t) => t.id)).toEqual(["t1", "t1b"]);
  });

  it("excludes completed tasks", () => {
    const sections = upcomingSections(
      [
        task("done", {
          showUpDate: "2024-01-12",
          completedAt: "2024-01-01T00:00:00.000Z",
        }),
        task("open", { showUpDate: "2024-01-12" }),
      ],
      today,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["open"]);
  });

  it("has no other gate: parks any future task regardless of project", () => {
    const sections = upcomingSections(
      [
        task("loose-future", { showUpDate: "2024-01-12" }),
        task("proj-future", {
          showUpDate: "2024-01-12",
          projectId: "p",
        }),
      ],
      today,
    );
    expect(sections[0].tasks.map((t) => t.id).sort()).toEqual([
      "loose-future",
      "proj-future",
    ]);
  });

  it("orders within a day by sortKey (nulls last)", () => {
    const sections = upcomingSections(
      [
        task("unkeyed", { showUpDate: "2024-01-12" }),
        task("b", { showUpDate: "2024-01-12", sortKey: "a1" }),
        task("a", { showUpDate: "2024-01-12", sortKey: "a0" }),
      ],
      today,
    );
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["a", "b", "unkeyed"]);
  });
});
