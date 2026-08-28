import { describe, expect, it } from "vitest";

import { inboxView } from "./view";

describe("inboxView", () => {
  // The whole point: a hydrated snapshot must paint even while the network
  // sync is still pending, so opening the Inbox never blinks to a spinner.
  it("shows rows whenever there are any, even while still loading", () => {
    expect(inboxView({ count: 1, isLoading: true, loadError: null })).toBe(
      "rows",
    );
    expect(inboxView({ count: 3, isLoading: false, loadError: null })).toBe(
      "rows",
    );
    // A failing refetch behind existing rows stays silent.
    expect(
      inboxView({ count: 2, isLoading: false, loadError: "offline" }),
    ).toBe("rows");
  });

  // Empty + loading shows the spinner (not the empty-state), so a snapshot that
  // has not hydrated yet never flashes "your inbox is empty".
  it("shows loading only when empty and still loading", () => {
    expect(inboxView({ count: 0, isLoading: true, loadError: null })).toBe(
      "loading",
    );
  });

  it("shows the error only when empty and an error is current", () => {
    expect(
      inboxView({ count: 0, isLoading: false, loadError: "offline" }),
    ).toBe("error");
    // A load error while still loading defers to loading until it settles.
    expect(
      inboxView({ count: 0, isLoading: true, loadError: "offline" }),
    ).toBe("loading");
  });

  it("shows the empty-state when settled with nothing to show", () => {
    expect(inboxView({ count: 0, isLoading: false, loadError: null })).toBe(
      "empty",
    );
  });
});
