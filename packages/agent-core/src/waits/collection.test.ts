import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createInMemoryWaitsApi, type WaitsRest } from "./collection";
import type { WaitingCondition } from "./types";

function fakeRest(): WaitsRest & { added: WaitingCondition[] } {
  const added: WaitingCondition[] = [];
  return {
    added,
    fetchWaits: async () => [],
    addWaitingCondition: async (condition) => {
      const row: WaitingCondition = {
        ...condition,
        resolvedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      added.push(row);
      return row;
    },
    resolveWaitingCondition: async () => {
      throw new Error("unused");
    },
    deleteWaitingCondition: async () => {},
  };
}

describe("waiting-condition collection", () => {
  it("creates the existing project-status/Done shape through dependOnProject", async () => {
    const rest = fakeRest();
    const api = createInMemoryWaitsApi({
      queryClient: new QueryClient(),
      rest,
    });
    await api.collection.stateWhenReady();

    const tx = api.dependOnProject("dependent", "prerequisite");
    const optimistic = tx.mutations[0]?.modified as WaitingCondition;
    expect(optimistic).toMatchObject({
      projectId: "dependent",
      kind: "project-status",
      text: null,
      refId: "prerequisite",
      targetStatus: "done",
      resolvedAt: null,
    });

    await tx.isPersisted.promise;
    expect(rest.added).toHaveLength(1);
  });
});
