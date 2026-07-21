import { describe, expect, it } from "vitest";
import { extractLinks, rewriteLinks } from "./links";

describe("extractLinks", () => {
  it("finds link names, trimmed and de-duplicated", () => {
    expect(
      extractLinks("See [[Trip to Japan]] and [[ Flights ]] and [[Trip to Japan]]."),
    ).toEqual(["Trip to Japan", "Flights"]);
  });

  it("returns nothing for prose without links", () => {
    expect(extractLinks("no links here [not a link]")).toEqual([]);
  });

  it("ignores malformed or empty brackets", () => {
    expect(extractLinks("[[]] [[ ]] [[unclosed and [single]")).toEqual([]);
  });
});

describe("rewriteLinks", () => {
  it("rewrites only exact-name tokens", () => {
    expect(rewriteLinks("[[Japan Trip]] near [[Japan]]", "Japan Trip", "Japan 2026")).toBe(
      "[[Japan 2026]] near [[Japan]]",
    );
  });

  it("rewrites every occurrence", () => {
    expect(rewriteLinks("[[A]] and [[A]]", "A", "B")).toBe("[[B]] and [[B]]");
  });

  it("leaves non-link prose untouched", () => {
    expect(rewriteLinks("A is not [[B]]", "A", "Z")).toBe("A is not [[B]]");
  });
});
