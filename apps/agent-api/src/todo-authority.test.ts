import { describe, expect, it } from "vitest";

import { canonicalTodoSnapshot, type TodoSnapshot } from "./todo-authority";

describe("canonicalTodoSnapshot", () => {
  it("compares field values independently of object insertion order", () => {
    const task = {
      id: "task-1", text: "Preserve me", showUpDate: null, recurrence: null,
      recurrenceDate: null, createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z", projectId: null,
      sourceCaptureId: null, sortKey: "a0",
    };
    const source: TodoSnapshot = {
      generation: "generation-1", tasks: [task], projects: [], conditions: [],
    };
    const imported = {
      generation: "generation-1",
      tasks: [{ text: task.text, id: task.id, sortKey: task.sortKey,
        projectId: task.projectId, completedAt: task.completedAt,
        createdAt: task.createdAt, recurrenceDate: task.recurrenceDate,
        recurrence: task.recurrence, showUpDate: task.showUpDate,
        sourceCaptureId: task.sourceCaptureId }],
      projects: [],
      conditions: [],
    } satisfies TodoSnapshot;

    expect(canonicalTodoSnapshot(imported)).toBe(canonicalTodoSnapshot(source));
  });
});
