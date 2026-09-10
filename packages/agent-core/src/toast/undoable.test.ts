import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@tanstack/db";

import { defaultToastController, toast } from "./controller";
import { undoableAction } from "./undoable";

// A stub transaction whose settled promise drives the error path.
function tx(promise: Promise<unknown> = Promise.resolve()): Transaction {
  return { isPersisted: { promise } } as unknown as Transaction;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("undoableAction", () => {
  afterEach(() => toast.dismiss());

  it("runs act immediately and shows one Undo toast keyed 'undo'", () => {
    const act = vi.fn(() => tx());
    undoableAction({ message: "Completed", act, undo: () => tx(), onError: vi.fn() });

    expect(act).toHaveBeenCalledTimes(1);
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: "undo", message: "Completed" });
    expect(snap[0].action?.label).toBe("Undo");
  });

  it("replaces the previous Undo toast so only one is ever shown", () => {
    undoableAction({ message: "Completed", act: () => tx(), undo: () => tx(), onError: vi.fn() });
    undoableAction({ message: "Completed", act: () => tx(), undo: () => tx(), onError: vi.fn() });
    expect(defaultToastController.getSnapshot()).toHaveLength(1);
  });

  it("carries an optional description and link, keeping Undo as the action", () => {
    const onPress = vi.fn();
    undoableAction({
      message: "Completed",
      description: "📁 Ship the app",
      link: { label: "Open", onPress },
      act: () => tx(),
      undo: () => tx(),
      onError: vi.fn(),
    });
    const snap = defaultToastController.getSnapshot();
    expect(snap[0].description).toBe("📁 Ship the app");
    expect(snap[0].link?.label).toBe("Open");
    expect(snap[0].action?.label).toBe("Undo");
    snap[0].link?.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("runs undo when the toast action is pressed", () => {
    const undo = vi.fn(() => tx());
    undoableAction({ message: "Completed", act: () => tx(), undo, onError: vi.fn() });
    defaultToastController.getSnapshot()[0].action?.onPress();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("routes a failed act to onError", async () => {
    const onError = vi.fn();
    undoableAction({
      message: "Completed",
      act: () => tx(Promise.reject(new Error("boom"))),
      undo: () => tx(),
      onError,
    });
    await flush();
    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("routes a failed undo to onError", async () => {
    const onError = vi.fn();
    undoableAction({
      message: "Completed",
      act: () => tx(),
      undo: () => tx(Promise.reject(new Error("nope"))),
      onError,
    });
    defaultToastController.getSnapshot()[0].action?.onPress();
    await flush();
    expect(onError).toHaveBeenCalledWith("nope");
  });
});
