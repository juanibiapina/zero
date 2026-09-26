import { describe, expect, it } from "vitest";

import { listView } from "./view";

describe("listView", () => {
  // The whole point: a hydrated snapshot must paint even while the live query
  // is settling, so opening a list never blinks to a spinner.
  it("shows rows whenever there are any, even while still loading", () => {
    expect(listView({ count: 1, isLoading: true })).toBe("rows");
    expect(listView({ count: 3, isLoading: false })).toBe("rows");
  });

  // Empty + loading shows the spinner (not the empty-state), so a snapshot that
  // has not hydrated yet never flashes "nothing yet".
  it("shows loading only when empty and still loading", () => {
    expect(listView({ count: 0, isLoading: true })).toBe("loading");
  });

  it("shows the empty-state when settled with nothing to show", () => {
    expect(listView({ count: 0, isLoading: false })).toBe("empty");
  });
});
