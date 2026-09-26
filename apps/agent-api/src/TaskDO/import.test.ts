import { describe, expect, it } from "vitest";

import type { TodoSnapshot } from "../todo-authority";
import { todoSnapshotTables } from "./import";

describe("todoSnapshotTables", () => {
  it("preserves missing Project references for visible recovery", () => {
    const snapshot: TodoSnapshot = {
      generation: "generation-1",
      projects: [],
      tasks: [{
        id: "task-1",
        text: "Keep me",
        showUpDate: null,
        recurrence: null,
        recurrenceDate: null,
        createdAt: "2026-09-26T00:00:00.000Z",
        completedAt: null,
        projectId: "missing-project",
        sourceCaptureId: null,
        sortKey: "a0",
      }],
      conditions: [{
        id: "after-1",
        projectId: "missing-source",
        kind: "project-status",
        text: null,
        refId: "missing-target",
        targetStatus: "done",
        resolvedAt: null,
        createdAt: "2026-09-26T00:00:01.000Z",
      }],
    };

    const tables = todoSnapshotTables(snapshot);

    expect(tables.tasks["task-1"]?.projectId).toBe("missing-project");
    expect(tables.conditions["after-1"]).toMatchObject({
      projectId: "missing-source",
      refId: "missing-target",
    });
  });
});
