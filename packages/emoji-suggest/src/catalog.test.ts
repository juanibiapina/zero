import { describe, expect, it } from "vitest";

import { CATEGORIES, COUNTRIES } from "./catalog";
import { emojiName } from "./names";

const graphemes = (text: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;

describe("catalog", () => {
  it("fits every question under 255 options", () => {
    expect(CATEGORIES.length).toBeLessThanOrEqual(255);
    for (const category of CATEGORIES) expect(category.emoji.length).toBeLessThanOrEqual(255);
    expect(Math.ceil(COUNTRIES.length / 2) + 1).toBeLessThanOrEqual(255);
  });

  it("has unique names and single-grapheme emoji", () => {
    const all = [...CATEGORIES.flatMap((c) => c.emoji), ...COUNTRIES];
    expect(new Set(all.map((e) => e.name)).size).toBe(all.length);
    expect(new Set(CATEGORIES.map((c) => c.label)).size).toBe(CATEGORIES.length);
    for (const e of all) expect(graphemes(e.emoji)).toBe(1);
  });

  it("names every emoji, flags included", () => {
    expect(emojiName("🐶")).toBe("dog face");
    expect(emojiName("🇭🇷")).toBe("flag: Croatia");
    expect(emojiName("not an emoji")).toBeUndefined();
  });
});
