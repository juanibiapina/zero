import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection } from "@tanstack/db";

import {
  createInMemoryProjectsApi,
  projectsReconcileWrites,
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
});

describe("projectsReconcileWrites", () => {
  it("inserts every server row when the collection is empty", () => {
    const writes = projectsReconcileWrites([], [project("a"), project("b")]);
    expect(writes).toEqual([
      { type: "insert", value: project("a") },
      { type: "insert", value: project("b") },
    ]);
  });

  it("updates rows already present instead of re-inserting them", () => {
    const writes = projectsReconcileWrites(["a"], [project("a"), project("b")]);
    expect(writes).toEqual([
      { type: "update", value: project("a") },
      { type: "insert", value: project("b") },
    ]);
  });

  it("deletes keys the server no longer returns", () => {
    const writes = projectsReconcileWrites(["a", "b"], [project("a")]);
    expect(writes).toEqual([
      { type: "update", value: project("a") },
      { type: "delete", key: "b" },
    ]);
  });

  it("clears everything when the server list is empty", () => {
    const writes = projectsReconcileWrites(["a", "b"], []);
    expect(writes).toEqual([
      { type: "delete", key: "a" },
      { type: "delete", key: "b" },
    ]);
  });
});
