import { describe, expect, it } from "vitest";
import { isBasisStale } from "./icon-suggestions";

describe("isBasisStale", () => {
  it("is not stale when title and description are unchanged", () => {
    expect(
      isBasisStale(
        { title: "Run a 5K", description: "under 30 min" },
        { title: "Run a 5K", description: "under 30 min" },
      ),
    ).toBe(false);
  });

  it("is stale when the description changed", () => {
    expect(
      isBasisStale(
        { title: "Run a 5K", description: null },
        { title: "Run a 5K", description: "under 30 min" },
      ),
    ).toBe(true);
  });

  it("is stale when the title changed", () => {
    expect(
      isBasisStale(
        { title: "Run a 5K", description: null },
        { title: "Run a marathon", description: null },
      ),
    ).toBe(true);
  });

  it("treats null and empty/whitespace description as the same", () => {
    expect(
      isBasisStale(
        { title: "x", description: null },
        { title: "x", description: "" },
      ),
    ).toBe(false);
    expect(
      isBasisStale(
        { title: "x", description: "   " },
        { title: "x", description: null },
      ),
    ).toBe(false);
  });

  it("ignores surrounding whitespace on the title", () => {
    expect(
      isBasisStale(
        { title: "Run a 5K", description: null },
        { title: "  Run a 5K  ", description: null },
      ),
    ).toBe(false);
  });
});
