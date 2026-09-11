import { describe, expect, it } from "vitest";

import { compareByOrder, orderKeyBetween } from "./order";

describe("orderKeyBetween", () => {
  it("mints a first key, then keys before/after/between", () => {
    const first = orderKeyBetween(null, null);
    const after = orderKeyBetween(first, null);
    const before = orderKeyBetween(null, first);
    const between = orderKeyBetween(first, after);

    expect(before < first).toBe(true);
    expect(first < between).toBe(true);
    expect(between < after).toBe(true);
  });
});

describe("compareByOrder", () => {
  const row = (sortKey: string | null, createdAt: string) => ({ sortKey, createdAt });

  it("orders by sortKey (raw codepoint), createdAt as tiebreak", () => {
    const list = [
      row("a2", "2020-01-01T00:00:00.000Z"),
      row("a1", "2020-01-01T00:00:00.000Z"),
      row("a1", "2019-01-01T00:00:00.000Z"),
    ];
    const sorted = [...list].sort(compareByOrder);
    expect(sorted.map((r) => `${r.sortKey}@${r.createdAt.slice(0, 4)}`)).toEqual([
      "a1@2019",
      "a1@2020",
      "a2@2020",
    ]);
  });

  it("sorts null keys last, createdAt among them", () => {
    const list = [
      row(null, "2020-01-02T00:00:00.000Z"),
      row("a0", "2020-01-01T00:00:00.000Z"),
      row(null, "2020-01-01T00:00:00.000Z"),
    ];
    const sorted = [...list].sort(compareByOrder);
    expect(sorted.map((r) => r.sortKey)).toEqual(["a0", null, null]);
    // Among the nulls, earlier createdAt first.
    expect(sorted[1].createdAt < sorted[2].createdAt).toBe(true);
  });
});
