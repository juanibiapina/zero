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
      const row: Project = {
        id,
        title,
        icon: "📁",
        description: null,
        state: "in-play",
        createdAt: new Date().toISOString(),
      };
      server.push(row);
      return { ...row };
    },
    setProjectState: async (id, state) => {
      await sleep(5);
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      row.state = state;
      if (state === "done") server.splice(server.indexOf(row), 1);
      return { ...row, state };
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
    deleteProject: async (id) => {
      await sleep(5);
      const index = server.findIndex((p) => p.id === id);
      if (index >= 0) server.splice(index, 1);
    },
  };
}

function expectNoFlicker(snapshots: string[][], id: string): void {
  for (const snapshot of snapshots) {
    expect(snapshot.filter((x) => x === id).length).toBeLessThanOrEqual(1);
  }
  const present = snapshots.map((s) => s.includes(id));
  const first = present.indexOf(true);
  if (first === -1) return;
  const last = present.lastIndexOf(true);
  for (let i = first; i <= last; i++) expect(present[i]).toBe(true);
}

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: id,
  icon: "📁",
  description: null,
  state: "in-play",
  createdAt: "2020-01-01T00:00:00.000Z",
  ...over,
});

describe("projects collection", () => {
  it("adds a canonical In-play row without flicker", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { title: "alpha" })]),
    });
    const list = createLiveQueryCollection((q) => q.from({ p: api.collection }));
    const snapshots: string[][] = [];
    const record = () => snapshots.push(list.toArray.map((p: Project) => p.title));
    list.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await list.preload();
    await sleep(50);
    record();

    const tx = api.add("beta");
    const optimistic = tx.mutations[0]?.modified as Project | undefined;
    expect(optimistic?.state).toBe("in-play");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    expect([...list.toArray.map((p: Project) => p.title)].sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expectNoFlicker(snapshots, "beta");
  });

  it("changes lifecycle state in place", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1")]),
    });
    await api.collection.stateWhenReady();

    const tx = api.setState("s1", "backlog");
    await tx.isPersisted.promise;
    await sleep(50);

    expect(api.collection.get("s1")?.state).toBe("backlog");
  });

  it("removes a project once its state is Done", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1")]),
    });
    await api.collection.stateWhenReady();

    await api.setState("s1", "done").isPersisted.promise;
    await sleep(50);

    expect(api.collection.has("s1")).toBe(false);
  });

  it("edits fields without changing state", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1", { title: "old", state: "backlog" })]),
    });
    await api.collection.stateWhenReady();

    await api
      .edit("s1", {
        title: "Run a 5K under 30 min",
        icon: "🏃",
        description: "By June",
      })
      .isPersisted.promise;
    await sleep(50);

    const row = api.collection.get("s1");
    expect(row?.title).toBe("Run a 5K under 30 min");
    expect(row?.icon).toBe("🏃");
    expect(row?.description).toBe("By June");
    expect(row?.state).toBe("backlog");
  });

  it("removes a deleted project", async () => {
    const api = createInMemoryProjectsApi({
      queryClient: new QueryClient(),
      rest: fakeRest([project("s1")]),
    });
    await api.collection.stateWhenReady();

    await api.remove("s1").isPersisted.promise;
    await sleep(50);

    expect(api.collection.has("s1")).toBe(false);
  });
});

describe("projects durable names", () => {
  it("uses the new state mutation name after the outbox epoch reset", () => {
    const spec = projectsSpec(fakeRest([]));
    expect(spec.name).toBe("projects");
    expect(Object.keys(spec.verbs).sort()).toEqual([
      "addProject",
      "deleteProject",
      "editProject",
      "setProjectState",
    ]);
  });
});
