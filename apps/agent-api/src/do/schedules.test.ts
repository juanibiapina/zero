import { describe, expect, it } from "vitest";
import { MAX_SKIP_SCAN, planFiring } from "./schedules";
import type { ScheduleRecord } from "../store/types";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-01-02T12:00:00Z").getTime();

const record = (patch: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: "sch_1",
  conversationId: "c1",
  prompt: "remind the user to call Ana",
  pattern: "daily",
  timezone: "UTC",
  nextDueAt: NOW - 1000,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastFiredAt: null,
  ...patch,
});

// A pattern that repeats every hour, and a one-shot that never comes again.
const nextRun = (pattern: string, _tz: string, after: number): number | null =>
  pattern === "daily" ? after + HOUR : null;

describe("planFiring", () => {
  it("plans nothing when nothing is due", () => {
    expect(planFiring({ due: [], now: NOW, nextRun })).toEqual([]);
  });

  it("advances a recurring schedule to its next occurrence", () => {
    const [fire] = planFiring({ due: [record()], now: NOW, nextRun });
    expect(fire.skipped).toBe(0);
    expect(fire.next).toBe(NOW - 1000 + HOUR);
  });

  it("plans one fire per due record", () => {
    const fires = planFiring({
      due: [record(), record({ id: "sch_2" })],
      now: NOW,
      nextRun,
    });
    expect(fires.map((f) => f.record.id)).toEqual(["sch_1", "sch_2"]);
  });

  it("collapses a backlog into a single fire and counts what was skipped", () => {
    // Due five hours ago on an hourly pattern: five more occurrences came and
    // went (four in between, plus the one landing on now).
    const [fire] = planFiring({
      due: [record({ nextDueAt: NOW - 5 * HOUR })],
      now: NOW,
      nextRun,
    });
    expect(fire.skipped).toBe(5);
    expect(fire.next).toBe(NOW + HOUR);
  });

  it("stops the catch-up walk at the scan bound", () => {
    const [fire] = planFiring({
      due: [record({ nextDueAt: NOW - 10_000 * HOUR })],
      now: NOW,
      nextRun,
    });
    expect(fire.skipped).toBe(MAX_SKIP_SCAN);
  });

  it("retires a one-shot", () => {
    const [fire] = planFiring({
      due: [record({ pattern: "2026-01-02T12:00:00" })],
      now: NOW,
      nextRun,
    });
    expect(fire.next).toBeNull();
  });

  it("retires a schedule whose pattern no longer parses", () => {
    const throwing = () => {
      throw new Error("bad pattern");
    };
    const [fire] = planFiring({ due: [record()], now: NOW, nextRun: throwing });
    expect(fire.next).toBeNull();
  });

  it("never fires a cancelled or retired record", () => {
    expect(
      planFiring({
        due: [record({ status: "cancelled" }), record({ nextDueAt: null })],
        now: NOW,
        nextRun,
      }),
    ).toEqual([]);
  });
});
