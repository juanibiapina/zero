import { describe, expect, it } from "vitest";

import { compareByOrder, orderKeyBetween } from "./order";

describe("orderKeyBetween", () => {
  it("mints the first key when both bounds are null", () => {
    const key = orderKeyBetween(null, null);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("mints a key after the last (tail)", () => {
    const first = orderKeyBetween(null, null);
    const tail = orderKeyBetween(first, null);
    expect(tail > first).toBe(true);
  });

  it("mints a key before the first (head)", () => {
    const first = orderKeyBetween(null, null);
    const head = orderKeyBetween(null, first);
    expect(head < first).toBe(true);
  });

  it("mints a key strictly between two neighbors", () => {
    const a = orderKeyBetween(null, null);
    const b = orderKeyBetween(a, null);
    const mid = orderKeyBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
  });
});

describe("compareByOrder", () => {
  const row = (sortKey: string | null, createdAt: string) => ({ sortKey, createdAt });

  it("orders by sortKey ascending", () => {
    expect(
      compareByOrder(row("a0", "2023-02-01"), row("a1", "2023-01-01")),
    ).toBeLessThan(0);
  });

  it("sorts a null sortKey after a keyed row", () => {
    expect(compareByOrder(row(null, "2023-01-01"), row("a0", "2023-02-01"))).toBe(1);
    expect(compareByOrder(row("a0", "2023-02-01"), row(null, "2023-01-01"))).toBe(-1);
  });

  it("falls back to createdAt when both keys are null", () => {
    expect(
      compareByOrder(row(null, "2023-01-01"), row(null, "2023-02-01")),
    ).toBeLessThan(0);
  });

  it("falls back to createdAt when keys are equal", () => {
    expect(
      compareByOrder(row("a0", "2023-01-01"), row("a0", "2023-02-01")),
    ).toBeLessThan(0);
  });

  it("compares keys by codepoint (uppercase before lowercase)", () => {
    expect(compareByOrder(row("Z", "2023-01-01"), row("a", "2023-01-01"))).toBe(-1);
  });
});
