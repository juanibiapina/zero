import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbWaitingConditionStore } from "./waiting-conditions";

const makeStore = () =>
  new DbWaitingConditionStore(createDb(createMockStorage()));

describe("DbWaitingConditionStore", () => {
  it("adds a free-text condition and lists it open", () => {
    const store = makeStore();
    const c = store.add("c1", "p1", "free-text", { text: "the letter comes back" });
    expect(c.id).toBe("c1");
    expect(c.projectId).toBe("p1");
    expect(c.kind).toBe("free-text");
    expect(c.text).toBe("the letter comes back");
    expect(c.resolvedAt).toBeNull();
    expect(store.listOpen()).toEqual([c]);
  });

  it("is exactly-once on the client id", () => {
    const store = makeStore();
    store.add("c1", "p1", "free-text", { text: "wait" });
    store.add("c1", "p1", "free-text", { text: "again" });
    const open = store.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].text).toBe("wait");
  });

  it("resolving a condition drops it from the open list", () => {
    const store = makeStore();
    store.add("c1", "p1", "free-text", { text: "wait" });
    const resolved = store.resolve("c1");
    expect(resolved?.resolvedAt).toBeTruthy();
    expect(store.listOpen()).toEqual([]);
  });

  it("stores a structured condition's ref and target", () => {
    const store = makeStore();
    const c = store.add("c2", "p1", "project-status", {
      refId: "p2",
      targetStatus: "done",
    });
    expect(c.refId).toBe("p2");
    expect(c.targetStatus).toBe("done");
  });

  it("delete is idempotent on the id", () => {
    const store = makeStore();
    store.add("c1", "p1", "free-text", { text: "wait" });
    expect(store.delete("c1")).toBe(true);
    expect(store.delete("c1")).toBe(false);
    expect(store.listOpen()).toEqual([]);
  });

  describe("deleteByProject", () => {
    it("deletes only conditions of the given project", () => {
      const store = makeStore();
      store.add("c1", "p1", "free-text", { text: "a" });
      store.add("c2", "p1", "free-text", { text: "b" });
      store.add("c3", "p2", "free-text", { text: "c" });

      const removed = store.deleteByProject("p1");

      expect(removed).toBe(2);
      expect(store.listOpen().map((c) => c.id)).toEqual(["c3"]);
    });

    it("deletes a resolved condition of the project too", () => {
      const store = makeStore();
      store.add("c1", "p1", "free-text", { text: "a" });
      store.resolve("c1");

      // The resolved row is off the open list but still stored; the cascade
      // removes it (1).
      expect(store.deleteByProject("p1")).toBe(1);
    });

    it("is a no-op for a project with no conditions", () => {
      const store = makeStore();
      store.add("c1", "p1", "free-text", { text: "a" });

      expect(store.deleteByProject("p2")).toBe(0);
      expect(store.listOpen()).toHaveLength(1);
    });
  });
});
