import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection } from "@tanstack/db";

import {
  createInMemoryProjectsApi,
  projectsSpec,
  type ProjectsRest,
} from "./collection";
import type { Project } from "./types";

// A fake Projects server with a small latency so the optimistic overlay and the
// reconciling refetch resolve on separate ticks (where a flicker would show).
function fakeRest(initial: Project[]): ProjectsRest {
  const server = initial.map((p) => ({ ...p }));
  return {
    fetchProjects: async () => {
      await sleep(5);
      return server.map((p) => ({ ...p }));
    },
    addProject: async ({ id, title }) => {
      await sleep(5);
      const existing = server.find((p) => p.id === id);
      if (existing) return { ...existing };
      const project: Project = {
        id,
        title,
        icon: "📁",
        description: null,
        status: "next",
        createdAt: new Date().toISOString(),
      };
      server.push(project);
      return { ...project };
    },
    setProjectStatus: async (id, status) => {
      await sleep(5);
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      row.status = status;
      // A done project leaves the working set the server returns.
      if (status === "done") {
        const i = server.indexOf(row);
        if (i >= 0) server.splice(i, 1);
      }
      return { ...row, status };
    },
    editProject: async (id, fields) => {
      await sleep(5);
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      if (fields.title !== undefined) row.title = fields.title;
      if (fields.icon !== undefined) row.icon = fields.icon;
      if (fields.description !== undefined) row.description = fields.description;
      return { ...row };
    },
  };
}

// Presence of an item across snapshots must be a single contiguous block of
// `true`, never doubled. Same invariant as the Task collection test.
function expectNoFlicker(snapshots: string[][], id: string): void {
  for (const snapshot of snapshots) {
    expect(snapshot.filter((x) => x === id).length).toBeLessThanOrEqual(1);
  }
  const present = snapshots.map((s) => s.includes(id));
  const firstTrue = present.indexOf(true);
  if (firstTrue === -1) return;
  const lastTrue = present.lastIndexOf(true);
  for (let i = firstTrue; i <= lastTrue; i++) {
    expect(present[i]).toBe(true);
  }
}

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: id,
  icon: "📁",
  description: null,
  status: "next",
  createdAt: "2020-01-01T00:00:00.000Z",
  ...over,
});

describe("projects collection", () => {
  it("adding a project shows it once, without a vanish/reappear flicker", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { title: "alpha" })]),
    });

    const list = createLiveQueryCollection((q) =>
      q.from({ p: api.collection }),
    );

    const snapshots: string[][] = [];
    const record = () => snapshots.push(list.toArray.map((p: Project) => p.title));
    list.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await list.preload();
    await sleep(50);
    record();

    const tx = api.add("beta");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    const finalTitles = list.toArray.map((p: Project) => p.title);
    expect([...finalTitles].sort()).toEqual(["alpha", "beta"]);
    expectNoFlicker(snapshots, "beta");
  });

  it("changes a project's status in place", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { status: "next" })]),
    });
    await api.collection.stateWhenReady();

    const tx = api.setStatus("s1", "active");
    await tx.isPersisted.promise;
    await sleep(50);

    expect(api.collection.get("s1")?.status).toBe("active");
  });

  it("removes a project from the collection once it is done", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { status: "next" })]),
    });
    await api.collection.stateWhenReady();

    const tx = api.setStatus("s1", "done");
    await tx.isPersisted.promise;
    await sleep(50);

    expect(api.collection.has("s1")).toBe(false);
  });

  it("edits a project's fields in place and keeps it in the collection", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { title: "old", status: "active" })]),
    });
    await api.collection.stateWhenReady();

    const tx = api.edit("s1", {
      title: "Run a 5K under 30 min",
      icon: "🏃",
      description: "By June",
    });
    await tx.isPersisted.promise;
    await sleep(50);

    const row = api.collection.get("s1");
    expect(row?.title).toBe("Run a 5K under 30 min");
    expect(row?.icon).toBe("🏃");
    expect(row?.description).toBe("By June");
    // An edit never changes status, and never drops the row.
    expect(row?.status).toBe("active");
  });
});

// The outbox persists queued offline writes by these names and the local cache
// table by the entity name. Renaming any strands offline writes.
describe("projects durable names", () => {
  it("keeps the collection id and outbox mutationFn names", () => {
    const spec = projectsSpec(fakeRest([]));
    expect(spec.name).toBe("projects");
    expect(Object.keys(spec.verbs).sort()).toEqual([
      "addProject",
      "editProject",
      "setProjectStatus",
    ]);
  });
});
