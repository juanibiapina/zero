import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";
import { describe, expect, it } from "vitest";

import { DbWaitingConditionStore } from "./waiting-conditions";

const makeStore = () =>
  new DbWaitingConditionStore(createDb(createMockStorage()));

describe("DbWaitingConditionStore", () => {
  it("adds and replays a manual Waiting condition exactly once", () => {
    const store = makeStore();
    const first = store.addWaiting("wait", "project", "the letter arrives");
    const replay = store.addWaiting("wait", "project", "different text");
    expect(replay).toEqual(first);
    expect(store.listOpen()).toEqual([first]);
  });

  it("resolves only manual Waiting conditions", () => {
    const store = makeStore();
    store.addWaiting("wait", "project", "the letter arrives");
    store.addAfter("after", "project", "target");

    expect(store.resolveWaiting("wait")?.resolvedAt).toBeTruthy();
    expect(store.resolveWaiting("after")?.resolvedAt).toBeNull();
    expect(store.listOpen().map((condition) => condition.id)).toEqual([
      "after",
    ]);
  });

  it("settles and restores every incoming After relationship", () => {
    const store = makeStore();
    store.addAfter("first", "a", "target");
    store.addAfter("second", "b", "target");
    store.addAfter("other", "a", "other-target");

    expect(store.resolveAftersForCompletedProject("target")).toBe(2);
    expect(store.listOpenAfters().map((condition) => condition.id)).toEqual([
      "other",
    ]);
    expect(store.restoreAftersForReopenedProject("target")).toBe(2);
    expect(store.listOpenAfters().map((condition) => condition.id).sort()).toEqual([
      "first",
      "other",
      "second",
    ]);
  });

  it("deletes owned and incoming rows independently", () => {
    const store = makeStore();
    store.addWaiting("owned-wait", "source", "a reply");
    store.addAfter("owned-after", "source", "other");
    store.addAfter("incoming", "dependent", "source");

    expect(store.deleteByProject("source")).toBe(2);
    expect(store.deleteByReferencedProject("source")).toBe(1);
    expect(store.listOpen()).toEqual([]);
  });

  it("keeps delete idempotent", () => {
    const store = makeStore();
    store.addWaiting("wait", "project", "a reply");
    expect(store.delete("wait")).toBe(true);
    expect(store.delete("wait")).toBe(false);
  });
});
