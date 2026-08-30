import { describe, expect, it } from "vitest";

import { todayView } from "./view";

describe("todayView", () => {
  it("shows rows whenever there are any, even while still loading", () => {
    expect(todayView({ count: 1, isLoading: true, loadError: null })).toBe(
      "rows",
    );
    expect(todayView({ count: 3, isLoading: false, loadError: null })).toBe(
      "rows",
    );
    expect(todayView({ count: 2, isLoading: false, loadError: "offline" })).toBe(
      "rows",
    );
  });

  it("shows loading only when empty and still loading", () => {
    expect(todayView({ count: 0, isLoading: true, loadError: null })).toBe(
      "loading",
    );
  });

  it("shows the error only when empty and an error is current", () => {
    expect(todayView({ count: 0, isLoading: false, loadError: "offline" })).toBe(
      "error",
    );
    expect(todayView({ count: 0, isLoading: true, loadError: "offline" })).toBe(
      "loading",
    );
  });

  it("shows the empty-state when settled with nothing to show", () => {
    expect(todayView({ count: 0, isLoading: false, loadError: null })).toBe(
      "empty",
    );
  });
});
