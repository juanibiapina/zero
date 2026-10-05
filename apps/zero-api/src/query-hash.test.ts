import { describe, expect, it } from "vitest";
import { queryHash } from "./query-hash";

describe("queryHash", () => {
  it("is stable for the same query", () => {
    expect(queryHash("mars distance")).toBe(queryHash("mars distance"));
  });

  it("ignores surrounding whitespace and case", () => {
    expect(queryHash("  Mars Distance ")).toBe(queryHash("mars distance"));
  });

  it("differs for different queries", () => {
    expect(queryHash("mars")).not.toBe(queryHash("venus"));
  });

  it("is 8 hex characters and reveals no query text", () => {
    const hash = queryHash("juan medical appointment");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).not.toContain("medical");
  });

  it("handles the empty query", () => {
    expect(queryHash("")).toMatch(/^[0-9a-f]{8}$/);
  });
});
