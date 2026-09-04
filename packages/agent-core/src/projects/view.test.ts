import { describe, expect, it } from "vitest";

import { projectsView } from "./view";

describe("projectsView", () => {
  it("shows rows whenever there are any, even while still loading", () => {
    expect(projectsView({ count: 1, isLoading: true, loadError: null })).toBe(
      "rows",
    );
    expect(projectsView({ count: 3, isLoading: false, loadError: null })).toBe(
      "rows",
    );
    expect(
      projectsView({ count: 2, isLoading: false, loadError: "offline" }),
    ).toBe("rows");
  });

  it("shows loading only when empty and still loading", () => {
    expect(projectsView({ count: 0, isLoading: true, loadError: null })).toBe(
      "loading",
    );
  });

  it("shows the error only when empty and an error is current", () => {
    expect(
      projectsView({ count: 0, isLoading: false, loadError: "offline" }),
    ).toBe("error");
    expect(
      projectsView({ count: 0, isLoading: true, loadError: "offline" }),
    ).toBe("loading");
  });

  it("shows the empty-state when settled with nothing to show", () => {
    expect(projectsView({ count: 0, isLoading: false, loadError: null })).toBe(
      "empty",
    );
  });
});
