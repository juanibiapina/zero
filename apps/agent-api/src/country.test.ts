import { describe, expect, it } from "vitest";
import { countryLabel, isValidCountry, resolveCountry } from "./country";

describe("country resolution", () => {
  it("accepts uppercase ISO alpha-2 country codes", () => {
    expect(isValidCountry("DE")).toBe(true);
    expect(isValidCountry("PT")).toBe(true);
  });

  it("normalizes lowercase input", () => {
    expect(resolveCountry("de")).toBe("DE");
    expect(resolveCountry(undefined, "pt")).toBe("PT");
  });

  it.each(["XX", "T1", "", "USA", "1"])(
    "rejects the unusable country value %j",
    (value) => {
      expect(resolveCountry(value)).toBeNull();
    },
  );

  it("prefers Cloudflare country over locale region", () => {
    expect(resolveCountry("DE", "PT")).toBe("DE");
  });

  it("falls back to locale region when Cloudflare is absent or unusable", () => {
    expect(resolveCountry(undefined, "PT")).toBe("PT");
    expect(resolveCountry("XX", "JP")).toBe("JP");
    expect(resolveCountry("T1", "DE")).toBe("DE");
  });

  it("returns null when neither signal is usable", () => {
    expect(resolveCountry()).toBeNull();
    expect(resolveCountry("XX", "USA")).toBeNull();
  });
});

describe("countryLabel", () => {
  it("names an assigned country code", () => {
    expect(countryLabel("DE")).toBe("Germany");
    expect(countryLabel("PT")).toBe("Portugal");
  });

  it("returns null for a well-formed code with no country behind it", () => {
    // ICU echoes an unassigned code back, and reports reserved ranges as
    // "Unknown Region"; neither is a name worth showing the model.
    expect(countryLabel("QQ")).toBeNull();
    expect(countryLabel("ZZ")).toBeNull();
  });
});
