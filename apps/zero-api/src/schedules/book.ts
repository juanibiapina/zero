// The ScheduleBook adapter over the store, bound to one conversation: the
// thread a schedule was created in is the thread it speaks in.
//
// Everything a create must get right lives here — the zone is real, the pattern
// is one we accept, the user is under the cap, and the first due time is
// resolved — so the tools stay a thin translation to the model's wire format.

import { isValidTimezone, suggestTimezones } from "../timezone";
import { log } from "../log";
import { nextRun as defaultNextRun, validatePattern as defaultValidate } from "./recurrence";
import type { ScheduleRecord, ScheduleRecordStore } from "../store/types";
import type {
  CreateScheduleResult,
  Schedule,
  ScheduleBook,
  ScheduleRejection,
} from "./types";

// Ceiling on active schedules per user. Every fire is a full agent turn, so
// this bounds what a confused model can book against one account.
export const MAX_ACTIVE_SCHEDULES = 50;

export interface ScheduleBookDeps {
  store: ScheduleRecordStore;
  conversationId: string;
  // Injected so tests stay deterministic.
  now?: () => number;
  nextRun?: (pattern: string, timezone: string, after: number) => number | null;
  validatePattern?: typeof defaultValidate;
  newId?: () => string;
}

const toSchedule = (record: ScheduleRecord): Schedule => ({
  id: record.id,
  prompt: record.prompt,
  pattern: record.pattern,
  timezone: record.timezone,
  nextDueAt: record.nextDueAt,
  createdAt: record.createdAt,
  lastFiredAt: record.lastFiredAt,
});

// Short enough to say out loud, wide enough that a user's active schedules do
// not collide.
const generateId = (): string =>
  `sch_${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;

export const createScheduleBook = (deps: ScheduleBookDeps): ScheduleBook => {
  const {
    store,
    conversationId,
    now = () => Date.now(),
    nextRun = defaultNextRun,
    validatePattern = defaultValidate,
    newId = generateId,
  } = deps;

  // A refusal is logged where its reason is known, by shape only: the pattern
  // and zone are the user's schedule, never their words.
  const reject = (
    reason: ScheduleRejection,
    error: string,
    suggestions?: string[],
  ): CreateScheduleResult => {
    log("schedule_rejected", { reason });
    return { error, reason, ...(suggestions ? { suggestions } : {}) };
  };

  return {
    create(input): CreateScheduleResult {
      if (!isValidTimezone(input.timezone)) {
        return reject(
          "timezone",
          `"${input.timezone}" is not a valid IANA timezone.`,
          suggestTimezones(input.timezone),
        );
      }
      const at = now();
      const check = validatePattern(input.pattern, input.timezone, at);
      if ("error" in check) return reject("pattern", check.error);
      // The cap counts every active schedule for the user, not this thread's.
      if (store.listSchedules().length >= MAX_ACTIVE_SCHEDULES) {
        return reject(
          "cap",
          `You already have ${MAX_ACTIVE_SCHEDULES} things scheduled, which is the limit. Cancel one first.`,
        );
      }
      const nextDueAt = nextRun(input.pattern, input.timezone, at);
      // validatePattern already established there is one; this is the type
      // narrowing, not a second policy.
      if (nextDueAt === null) {
        return reject("pattern", `"${input.pattern}" never comes due again.`);
      }
      const record = store.createSchedule({
        id: newId(),
        conversationId,
        prompt: input.prompt,
        pattern: input.pattern,
        timezone: input.timezone,
        nextDueAt,
      });
      log("schedule_created", {
        pattern: record.pattern,
        timezone: record.timezone,
        due_in_ms: nextDueAt - at,
      });
      return { schedule: toSchedule(record) };
    },

    list(): Schedule[] {
      return store.listSchedules(conversationId).map(toSchedule);
    },

    cancel(id: string): boolean {
      const cancelled = store.cancelSchedule(id);
      if (cancelled) log("schedule_cancelled", {});
      return cancelled;
    },
  };
};
