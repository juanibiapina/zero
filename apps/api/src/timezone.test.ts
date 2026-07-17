import { describe, it, expect } from "vitest";
import { isValidTimezone, suggestTimezones, DEFAULT_TIMEZONE } from "./timezone";

describe("isValidTimezone", () => {
  it("accepts canonical IANA zones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
  });

  it("rejects junk and non-canonical strings", () => {
    expect(isValidTimezone("Europe/Cologne")).toBe(false);
    expect(isValidTimezone("+02:00")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("PST")).toBe(false);
  });

  it("treats the default as valid", () => {
    expect(isValidTimezone(DEFAULT_TIMEZONE)).toBe(true);
  });
});

describe("suggestTimezones", () => {
  it("matches on city segment with spaces", () => {
    expect(suggestTimezones("tokyo")).toContain("Asia/Tokyo");
    expect(suggestTimezones("new york")).toContain("America/New_York");
    expect(suggestTimezones("sao paulo")).toContain("America/Sao_Paulo");
  });

  it("caps the number of suggestions", () => {
    expect(suggestTimezones("america", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for an empty query", () => {
    expect(suggestTimezones("")).toEqual([]);
  });
});
