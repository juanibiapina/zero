import { describe, expect, it, vi } from "vitest";
import { buildCountryTool } from "./country";

const run = (tool: ReturnType<typeof buildCountryTool>, country: string) =>
  (tool.set_country.execute as (input: { country: string }) => Promise<unknown>)({
    country,
  });

describe("set_country tool", () => {
  it("stores and echoes a valid country", async () => {
    const setCountry = vi.fn();
    const result = await run(buildCountryTool({ setCountry }), "PT");
    expect(setCountry).toHaveBeenCalledWith("PT");
    expect(result).toEqual({ ok: true, country: "PT" });
  });

  it("normalizes lowercase country codes", async () => {
    const setCountry = vi.fn();
    const result = await run(buildCountryTool({ setCountry }), "jp");
    expect(setCountry).toHaveBeenCalledWith("JP");
    expect(result).toEqual({ ok: true, country: "JP" });
  });

  it("rejects invalid codes without storing them", async () => {
    const setCountry = vi.fn();
    const result = (await run(buildCountryTool({ setCountry }), "USA")) as {
      error: string;
    };
    expect(setCountry).not.toHaveBeenCalled();
    expect(result.error).toContain("ISO 3166-1 alpha-2");
  });

  it("reports when it cannot persist", async () => {
    const result = (await run(buildCountryTool({}), "DE")) as { error: string };
    expect(result.error).toContain("Can't change the country");
  });
});
