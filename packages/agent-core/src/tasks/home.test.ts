import { describe, expect, it } from "vitest";

import { homeTasks } from "./home";
import type { Task } from "./types";

function task(over: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: over.id,
    text: over.text ?? over.id,
    showUpDate: over.showUpDate ?? "2026-01-01",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? null,
  };
}

describe("homeTasks", () => {
  it("returns open tasks oldest-first", () => {
    const out = homeTasks([
      task({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
      task({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      task({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes completed tasks", () => {
    const out = homeTasks([
      task({ id: "open" }),
      task({ id: "done", completedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["open"]);
  });

  it("ignores showUpDate (availability, not date, gates the list)", () => {
    const out = homeTasks([
      task({ id: "future", showUpDate: "2099-01-01" }),
      task({ id: "past", showUpDate: "2000-01-01" }),
    ]);
    expect(out.map((t) => t.id).sort()).toEqual(["future", "past"]);
  });

  it("returns an empty list unchanged", () => {
    expect(homeTasks([])).toEqual([]);
  });
});
