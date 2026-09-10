import { describe, expect, it } from "vitest";

import { waitingLabel } from "./waiting-label";

// A fixed "now" so the phrases are deterministic.
const NOW = new Date("2026-06-01T12:00:00.000Z");

// `since` = NOW shifted back by the given milliseconds.
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("waitingLabel", () => {
  it("floors a sub-minute wait to 'just now'", () => {
    expect(waitingLabel(ago(0), NOW)).toBe("just now");
    expect(waitingLabel(ago(30 * SECOND), NOW)).toBe("just now");
  });

  it("reads minutes", () => {
    expect(waitingLabel(ago(5 * MINUTE), NOW)).toBe("5 minutes");
    expect(waitingLabel(ago(1 * MINUTE), NOW)).toBe("1 minute");
  });

  it("reads hours", () => {
    expect(waitingLabel(ago(3 * HOUR), NOW)).toBe("3 hours");
  });

  it("reads days", () => {
    expect(waitingLabel(ago(1 * DAY), NOW)).toBe("1 day");
    expect(waitingLabel(ago(3 * DAY), NOW)).toBe("3 days");
  });

  it("reads months", () => {
    expect(waitingLabel(ago(60 * DAY), NOW)).toBe("2 months");
  });

  it("reads years", () => {
    expect(waitingLabel(ago(365 * DAY), NOW)).toBe("1 year");
  });

  it("carries no 'ago' suffix", () => {
    expect(waitingLabel(ago(3 * DAY), NOW)).not.toContain("ago");
  });
});
