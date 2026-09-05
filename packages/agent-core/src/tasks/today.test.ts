import { describe, expect, it } from "vitest";

import { dueToday, localToday } from "./today";
import type { Task } from "./types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  showUpDate: "2024-01-10",
  createdAt: "2024-01-10T00:00:00.000Z",
  completedAt: null,
  projectId: null,
  ...over,
});

describe("localToday", () => {
  it("formats the local date as YYYY-MM-DD, zero-padded", () => {
    // Local-time constructor so the assertion holds in any timezone.
    expect(localToday(new Date(2024, 0, 5))).toBe("2024-01-05");
    expect(localToday(new Date(2024, 10, 30))).toBe("2024-11-30");
  });
});

describe("dueToday", () => {
  const today = "2024-01-10";

  it("includes tasks dated today and overdue, excludes future", () => {
    const list = dueToday(
      [
        task("future", { showUpDate: "2024-01-11" }),
        task("today", { showUpDate: "2024-01-10" }),
        task("overdue", { showUpDate: "2024-01-01" }),
      ],
      today,
    );
    expect(list.map((t) => t.id)).toEqual(["overdue", "today"]);
  });

  it("excludes completed tasks", () => {
    const list = dueToday(
      [
        task("done", { showUpDate: "2024-01-10", completedAt: "2024-01-10T09:00:00.000Z" }),
        task("open", { showUpDate: "2024-01-10" }),
      ],
      today,
    );
    expect(list.map((t) => t.id)).toEqual(["open"]);
  });

  it("orders by day, then creation order within a day", () => {
    const list = dueToday(
      [
        task("a", { showUpDate: "2024-01-10", createdAt: "2024-01-10T10:00:00.000Z" }),
        task("b", { showUpDate: "2024-01-09", createdAt: "2024-01-09T10:00:00.000Z" }),
        task("c", { showUpDate: "2024-01-10", createdAt: "2024-01-10T08:00:00.000Z" }),
      ],
      today,
    );
    expect(list.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});
