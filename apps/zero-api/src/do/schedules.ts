// Firing policy for due schedules, kept free of the Durable Object so it is
// testable without one (same posture as do/schedule.ts).
//
// Catch-up: downtime spanning several occurrences collapses into a single fire.
// Forty backlogged "good morning" messages are worse than the ones that were
// missed, so the plan reports how many were skipped and moves the record to the
// next future occurrence.

import { log } from "../log";
import type { ScheduleRecord, ScheduleRecordStore } from "../store/types";

// Bound on the catch-up walk. A record parked for a year on a 15-minute pattern
// would otherwise step through 35,000 occurrences to find "now".
export const MAX_SKIP_SCAN = 500;

export interface ScheduleFire {
  record: ScheduleRecord;
  // Occurrences that came and went while nothing fired. Reported, never fired.
  skipped: number;
  // The next future occurrence, or null when the schedule is finished (a
  // one-shot, or a pattern that will not come round again).
  next: number | null;
}

// What to do with everything that is due. `nextRun` is injected so the policy
// is exercised without a real recurrence evaluator.
export const planFiring = (input: {
  due: ScheduleRecord[];
  now: number;
  nextRun: (pattern: string, timezone: string, after: number) => number | null;
}): ScheduleFire[] => {
  const fires: ScheduleFire[] = [];
  for (const record of input.due) {
    if (record.status !== "active" || record.nextDueAt === null) continue;
    let skipped = 0;
    let cursor = record.nextDueAt;
    let next = safeNextRun(input.nextRun, record, cursor);
    while (next !== null && next <= input.now && skipped < MAX_SKIP_SCAN) {
      skipped++;
      cursor = next;
      next = safeNextRun(input.nextRun, record, cursor);
    }
    fires.push({ record, skipped, next });
  }
  return fires;
};

// A pattern that stopped parsing (a croner upgrade, a hand-edited row) must not
// take the whole firing pass down: the schedule retires instead.
const safeNextRun = (
  nextRun: (pattern: string, timezone: string, after: number) => number | null,
  record: ScheduleRecord,
  after: number,
): number | null => {
  try {
    return nextRun(record.pattern, record.timezone, after);
  } catch {
    return null;
  }
};

export type ScheduleFiringStore = ScheduleRecordStore;

// Fire everything due: hand each prompt to the assistant, then advance or
// retire its record. The submission carries the schedule id and the due time,
// so a reset between the two submits the same occurrence again and the
// assistant answers it once.
export const fireDueSchedules = async (input: {
  store: ScheduleFiringStore;
  now: number;
  nextRun: (pattern: string, timezone: string, after: number) => number | null;
  // Wrap a schedule's prompt as the text of a turn (the SCHEDULE_NOTE prefix).
  composeText: (prompt: string) => string;
  submit: (conversationId: string, text: string, operationId: string) => Promise<void>;
}): Promise<number> => {
  const { store, now } = input;
  const fires = planFiring({
    due: store.listDueSchedules(now),
    now,
    nextRun: input.nextRun,
  });
  const lastFiredAt = new Date(now).toISOString();
  for (const fire of fires) {
    logScheduleFired(fire, now);
    await input.submit(
      fire.record.conversationId,
      input.composeText(fire.record.prompt),
      `schedule:${fire.record.id}:${fire.record.nextDueAt}`,
    );
    if (fire.next === null) {
      store.retireSchedule(fire.record.id, { lastFiredAt });
      logScheduleRetired();
    } else {
      store.advanceSchedule(fire.record.id, { nextDueAt: fire.next, lastFiredAt });
    }
  }
  logSchedulesFinished({ fired: fires.length });
  return fires.length;
};

export const logScheduleFired = (fire: ScheduleFire, now: number): void =>
  log("schedule_fired", {
    late_ms: Math.max(0, now - (fire.record.nextDueAt ?? now)),
    skipped: fire.skipped,
    recurring: fire.next !== null,
  });

export const logScheduleRetired = (): void => log("schedule_retired", {});

export const logSchedulesFinished = (input: { fired: number }): void =>
  log("schedules_finished", { fired: input.fired });
