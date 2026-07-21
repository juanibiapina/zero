import { describe, it, expect, vi } from "vitest";
import { buildTimezoneTool } from "./timezone";

const run = (tool: ReturnType<typeof buildTimezoneTool>, timezone: string) =>
  (tool.set_timezone.execute as (a: { timezone: string }) => Promise<unknown>)({
    timezone,
  });

describe("set_timezone tool", () => {
  it("stores a valid IANA zone", async () => {
    const setTimezone = vi.fn();
    const tool = buildTimezoneTool({ setTimezone });
    const result = await run(tool, "Asia/Tokyo");
    expect(setTimezone).toHaveBeenCalledWith("Asia/Tokyo");
    expect(result).toEqual({ ok: true, timezone: "Asia/Tokyo" });
  });

  it("rejects an invalid zone with suggestions and does not store", async () => {
    const setTimezone = vi.fn();
    const tool = buildTimezoneTool({ setTimezone });
    const result = (await run(tool, "Tokyo")) as {
      error: string;
      suggestions: string[];
    };
    expect(setTimezone).not.toHaveBeenCalled();
    expect(result.error).toContain("not a valid");
    expect(result.suggestions).toContain("Asia/Tokyo");
  });

  it("reports when it cannot persist (no setter)", async () => {
    const tool = buildTimezoneTool({});
    const result = (await run(tool, "Asia/Tokyo")) as { error: string };
    expect(result.error).toContain("Can't change the timezone");
  });
});
