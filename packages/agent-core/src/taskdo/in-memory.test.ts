import { describe, expect, it } from "vitest";
import { projectParent } from "../tasks/parent";

import {
  createInMemoryTaskdoClientState,
  createInMemoryTaskdoReplica,
} from "./in-memory";

describe("in-memory TaskDO replica", () => {
  it("creates ready client state from the replica snapshot", async () => {
    const { state, replica } = createInMemoryTaskdoClientState({
      tasks: [{
        id: "orphan", text: "Orphan", parent: projectParent("missing"), showUpDate: null,
        recurrence: null, recurrenceDate: null,
        completedAt: null, createdAt: "2026-09-25T10:00:00.000Z", sortKey: null,
      }],
    });

    expect(state).toEqual({
      replica,
      ready: true,
      connected: true,
      sync: { phase: "synced", lastSyncedAt: null },
      durable: true,
      error: null,
      durabilityError: null,
      recoveries: [{
        table: "tasks",
        id: "orphan",
        text: "Orphan",
        reason: "Missing Project",
        repair: "make-task-loose",
      }],
    });
    await replica.close();
  });

  it("seeds all todo entities behind the same public replica interface", async () => {
    const replica = createInMemoryTaskdoReplica({
      projects: [{
        id: "project", title: "Project", icon: "📁", description: null,
        state: "in-play", createdAt: "2026-09-25T10:00:00.000Z",
      }],
      tasks: [{
        id: "task", text: "Task", parent: projectParent("project"), showUpDate: null,
        recurrence: null, recurrenceDate: null,
        completedAt: null, createdAt: "2026-09-25T10:00:00.000Z", sortKey: null,
      }],
      waits: [{
        id: "wait", projectId: "project", kind: "free-text", text: "Reply",
        refId: null, targetStatus: null, resolvedAt: null,
        createdAt: "2026-09-25T10:00:00.000Z",
      }],
    });

    expect(replica.snapshot()).toMatchObject({
      projects: [{ id: "project" }],
      tasks: [{ id: "task", parent: { kind: "project", projectId: "project" }, recurrence: null, recurrenceDate: null }],
      conditions: [{ id: "wait", projectId: "project" }],
    });
    await Promise.all([
      replica.tasks.collection.preload(),
      replica.projects.collection.preload(),
      replica.waits.collection.preload(),
    ]);
    expect(replica.tasks.collection.get("task")).toMatchObject({ recurrence: null, recurrenceDate: null });
    await replica.tasks.edit("task", "Edited").isPersisted.promise;
    expect(replica.snapshot().tasks[0]?.text).toBe("Edited");
    await replica.close();
  });
});
