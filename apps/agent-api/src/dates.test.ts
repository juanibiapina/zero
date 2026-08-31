import { describe, expect, it } from "vitest";

import { localDayInZone } from "./dates";

describe("localDayInZone", () => {
  it("formats the local day as YYYY-MM-DD", () => {
    const now = new Date("2024-03-09T12:00:00.000Z");
    expect(localDayInZone(now, "UTC")).toBe("2024-03-09");
  });

  it("shifts the calendar day back for a timezone behind UTC", () => {
    // 03:00 UTC is still the previous evening in São Paulo (UTC-3).
    const now = new Date("2024-03-09T03:00:00.000Z");
    expect(localDayInZone(now, "UTC")).toBe("2024-03-09");
    expect(localDayInZone(now, "America/Sao_Paulo")).toBe("2024-03-09");

    const midnightUtc = new Date("2024-03-09T00:30:00.000Z");
    expect(localDayInZone(midnightUtc, "America/Sao_Paulo")).toBe("2024-03-08");
  });

  it("shifts the calendar day forward for a timezone ahead of UTC", () => {
    // 22:00 UTC is already the next day in Tokyo (UTC+9).
    const now = new Date("2024-03-09T22:00:00.000Z");
    expect(localDayInZone(now, "UTC")).toBe("2024-03-09");
    expect(localDayInZone(now, "Asia/Tokyo")).toBe("2024-03-10");
  });
});
