import { describe as group, expect, it } from "vitest";
import {
  describe,
  formatLocal,
  MIN_INTERVAL_MS,
  nextRun,
  upcoming,
  validatePattern,
} from "./recurrence";

const at = (iso: string): number => new Date(iso).getTime();

const errorOf = (result: ReturnType<typeof validatePattern>): string =>
  "error" in result ? result.error : "";

group("nextRun", () => {
  it("resolves a weekday pattern in the user's zone", () => {
    // Friday 2026-01-02 12:00 Berlin (CET, +01) → Monday 08:00 local = 07:00Z.
    const next = nextRun("0 8 * * 1-5", "Europe/Berlin", at("2026-01-02T12:00:00Z"));
    expect(new Date(next!).toISOString()).toBe("2026-01-05T07:00:00.000Z");
  });

  it("follows the zone across a DST switch", () => {
    // Berlin moves to CEST on 2026-03-29, so 08:00 local becomes 06:00Z.
    const before = nextRun("0 8 * * 1-5", "Europe/Berlin", at("2026-03-26T12:00:00Z"));
    const after = nextRun("0 8 * * 1-5", "Europe/Berlin", at("2026-03-29T12:00:00Z"));
    expect(new Date(before!).toISOString()).toBe("2026-03-27T07:00:00.000Z");
    expect(new Date(after!).toISOString()).toBe("2026-03-30T06:00:00.000Z");
  });

  it("follows a southern-hemisphere zone with no DST", () => {
    // São Paulo dropped DST in 2019, so the offset stays -03 all year.
    const jan = nextRun("0 8 * * *", "America/Sao_Paulo", at("2026-01-10T20:00:00Z"));
    const jul = nextRun("0 8 * * *", "America/Sao_Paulo", at("2026-07-10T20:00:00Z"));
    expect(new Date(jan!).toISOString()).toBe("2026-01-11T11:00:00.000Z");
    expect(new Date(jul!).toISOString()).toBe("2026-07-11T11:00:00.000Z");
  });

  it("still fires on a day whose local time falls in the spring-forward gap", () => {
    // 02:30 does not exist in Berlin on 2026-03-29; the occurrence shifts
    // rather than vanishing.
    const next = nextRun("30 2 * * *", "Europe/Berlin", at("2026-03-28T12:00:00Z"));
    expect(next).not.toBeNull();
    expect(new Date(next!).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("fires once across a fall-back overlap", () => {
    // 02:30 happens twice in Berlin on 2026-10-25 (CEST then CET).
    const runs = upcoming("30 2 * * *", "Europe/Berlin", at("2026-10-24T12:00:00Z"), 2);
    expect(new Date(runs[0]).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(new Date(runs[1]).toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });

  it("resolves an ISO-8601 local datetime as a one-shot", () => {
    const next = nextRun("2026-08-05T18:00:00", "Europe/Berlin", at("2026-08-01T00:00:00Z"));
    expect(new Date(next!).toISOString()).toBe("2026-08-05T16:00:00.000Z");
  });

  it("returns null for a one-shot that has passed", () => {
    expect(
      nextRun("2026-08-05T18:00:00", "Europe/Berlin", at("2026-08-06T00:00:00Z")),
    ).toBeNull();
  });
});

group("validatePattern", () => {
  const now = at("2026-01-02T12:00:00Z");

  it("accepts a weekday cron pattern", () => {
    expect(validatePattern("0 8 * * 1-5", "Europe/Berlin", now)).toEqual({ ok: true });
  });

  it("accepts a future one-shot", () => {
    expect(validatePattern("2026-08-05T18:00:00", "Europe/Berlin", now)).toEqual({
      ok: true,
    });
  });

  it("rejects an unparseable pattern", () => {
    const result = validatePattern("every morning", "Europe/Berlin", now);
    expect(result).toHaveProperty("error");
  });

  it("rejects a seconds field", () => {
    const result = validatePattern("*/5 * * * * *", "Europe/Berlin", now);
    expect(errorOf(result)).toContain("five-field");
  });

  it("rejects a one-shot already in the past", () => {
    const result = validatePattern("2025-01-01T09:00:00", "Europe/Berlin", now);
    expect(errorOf(result)).toContain("never comes due");
  });

  it("rejects a pattern more frequent than the floor", () => {
    const result = validatePattern("*/5 * * * *", "Europe/Berlin", now);
    expect(errorOf(result)).toContain("more often than every 15 minutes");
  });

  it("accepts a pattern exactly at the floor", () => {
    expect(validatePattern("*/15 * * * *", "Europe/Berlin", now)).toEqual({ ok: true });
    expect(MIN_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});

group("describe", () => {
  it("names a weekday pattern", () => {
    expect(describe("0 8 * * 1-5", "Europe/Berlin")).toBe(
      "every weekday at 08:00 (Europe/Berlin)",
    );
  });

  it("names a daily pattern", () => {
    expect(describe("30 6 * * *", "Europe/Berlin")).toBe(
      "every day at 06:30 (Europe/Berlin)",
    );
  });

  it("names single and multiple weekdays", () => {
    expect(describe("0 9 * * 1", "UTC")).toBe("every Monday at 09:00 (UTC)");
    expect(describe("0 9 * * 1,4", "UTC")).toBe(
      "every Monday and Thursday at 09:00 (UTC)",
    );
  });

  it("names a monthly and an interval pattern", () => {
    expect(describe("0 9 1 * *", "UTC")).toBe(
      "on day 1 of every month at 09:00 (UTC)",
    );
    expect(describe("*/30 * * * *", "UTC")).toBe("every 30 minutes (UTC)");
    expect(describe("0 */6 * * *", "UTC")).toBe(
      "every 6 hours at minute 00 (UTC)",
    );
  });

  it("renders a one-shot as its local moment", () => {
    expect(describe("2026-08-05T18:00:00", "Europe/Berlin")).toBe(
      "Wed 2026-08-05 18:00 (Europe/Berlin)",
    );
  });

  it("still renders a one-shot whose moment has passed", () => {
    expect(describe("2020-02-29T09:05:00", "UTC")).toBe(
      "Sat 2020-02-29 09:05 (UTC)",
    );
  });

  it("falls back to the raw pattern when it recognises nothing", () => {
    expect(describe("0 8 3 6 2", "UTC")).toBe("0 8 3 6 2 (UTC)");
  });
});

group("formatLocal", () => {
  it("renders an instant in the schedule's zone", () => {
    expect(formatLocal(at("2026-08-05T16:00:00Z"), "Europe/Berlin")).toBe(
      "Wed 2026-08-05 18:00 (Europe/Berlin)",
    );
  });
});
