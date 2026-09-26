import { describe, expect, it } from "vitest";

import { createInMemoryTaskdoReplica } from "./in-memory";

describe("in-memory TaskDO replica", () => {
  it("seeds all todo entities behind the same public replica interface", async () => {
    const replica = createInMemoryTaskdoReplica({
      projects: [{
        id: "project", title: "Project", icon: "📁", description: null,
        state: "in-play", createdAt: "2026-09-25T10:00:00.000Z",
      }],
      tasks: [{
        id: "task", text: "Task", projectId: "project", showUpDate: null,
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
      tasks: [{ id: "task", projectId: "project" }],
      conditions: [{ id: "wait", projectId: "project" }],
    });
    await Promise.all([
      replica.tasks.collection.preload(),
      replica.projects.collection.preload(),
      replica.waits.collection.preload(),
    ]);
    await replica.tasks.edit("task", "Edited").isPersisted.promise;
    expect(replica.snapshot().tasks[0]?.text).toBe("Edited");
    await replica.close();
  });
});
