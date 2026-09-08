import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToastController } from "./controller";

describe("toast controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("show appends a toast and returns its id", () => {
    const c = createToastController();
    const id = c.show("Saved");
    const snap = c.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, message: "Saved" });
  });

  it("carries description and action through", () => {
    const c = createToastController();
    const onPress = vi.fn();
    c.show({ message: "Project created", description: "ship the app", action: { label: "View", onPress } });
    const [t] = c.getSnapshot();
    expect(t.description).toBe("ship the app");
    t.action?.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses after the default duration", () => {
    const c = createToastController({ defaultDurationMs: 4000 });
    c.show("Saved");
    expect(c.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    expect(c.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot()).toHaveLength(0);
  });

  it("honors a per-toast duration", () => {
    const c = createToastController({ defaultDurationMs: 4000 });
    c.show({ message: "quick", durationMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(c.getSnapshot()).toHaveLength(0);
  });

  it("never auto-dismisses a sticky (Infinity) toast", () => {
    const c = createToastController();
    c.show({ message: "sticky", durationMs: Infinity });
    vi.advanceTimersByTime(1_000_000);
    expect(c.getSnapshot()).toHaveLength(1);
  });

  it("dismiss(id) removes just that toast; dismiss() clears all", () => {
    const c = createToastController();
    const a = c.show({ message: "a", durationMs: Infinity });
    c.show({ message: "b", durationMs: Infinity });
    c.dismiss(a);
    expect(c.getSnapshot().map((t) => t.message)).toEqual(["b"]);
    c.dismiss();
    expect(c.getSnapshot()).toHaveLength(0);
  });

  it("re-showing an existing id replaces in place and restarts its timer", () => {
    const c = createToastController({ defaultDurationMs: 1000 });
    c.show({ id: "x", message: "first" });
    vi.advanceTimersByTime(900);
    c.show({ id: "x", message: "second" });
    const snap = c.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("second");
    // The original timer would have fired at 1000ms; the replace restarted it.
    vi.advanceTimersByTime(200);
    expect(c.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(800);
    expect(c.getSnapshot()).toHaveLength(0);
  });

  it("caps the retained list at maxVisible, dropping the oldest", () => {
    const c = createToastController({ maxVisible: 2, defaultDurationMs: Infinity });
    c.show({ message: "a" });
    c.show({ message: "b" });
    c.show({ message: "c" });
    expect(c.getSnapshot().map((t) => t.message)).toEqual(["b", "c"]);
  });

  it("getSnapshot is stable until a change, fresh after", () => {
    const c = createToastController({ defaultDurationMs: Infinity });
    const s0 = c.getSnapshot();
    c.show({ id: "x", message: "a" });
    const s1 = c.getSnapshot();
    expect(s1).not.toBe(s0);
    expect(c.getSnapshot()).toBe(s1); // no change → same reference
    c.dismiss("x");
    expect(c.getSnapshot()).not.toBe(s1);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const c = createToastController({ defaultDurationMs: Infinity });
    const cb = vi.fn();
    const unsub = c.subscribe(cb);
    const id = c.show("a");
    expect(cb).toHaveBeenCalledTimes(1);
    c.dismiss(id);
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    c.show("b");
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
