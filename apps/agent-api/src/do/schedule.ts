// Deadline bookkeeping for ScheduleDO, kept free of the Durable Object so it is
// testable without one (same shape as do/alarm.ts).
//
// Why a separate object owns deadlines at all: a Durable Object has exactly one
// alarm. On 2026-07-29 UserDO's single alarm was shared between turn draining,
// an admin task and onboarding, and a queued user message waited a quarter of an
// hour behind them. Deadlines therefore live in their own DO, whose alarm can
// stall without ever delaying a reply.

import { fmtErr, log, logError } from "../log";

// What a deadline is for. `idle` and `size` both mean "learn"; the other two are
// the existing UserDO jobs whose timers move here.
export type ScheduleReason = "idle" | "size" | "onboarding" | "admin_task";

export interface Deadline {
  reason: ScheduleReason;
  // Epoch ms this deadline comes due.
  dueAt: number;
  // The conversation a learning deadline is about. Absent for user-wide jobs.
  conversationId?: string;
  // How many dispatches of this entry have already failed. Absent until one
  // does.
  attempts?: number;
}

// Retry policy for a dispatch that threw. Taking a deadline removes it, so
// without this a transient RPC failure would silently drop the work: `idle` and
// `size` come back on the user's next message, but nothing ever re-requests
// onboarding or an admin task.
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_MAX_MS = 60 * 60 * 1000;
export const RETRY_MAX_ATTEMPTS = 6;

// The same deadline, due again later, or null once it has failed too often to
// be worth keeping. Exponential so a target that is down does not get hammered,
// capped so a retry never disappears an hour and a half into the future.
export const retryDeadline = (
  entry: Deadline,
  now: number,
): Deadline | null => {
  const attempts = (entry.attempts ?? 0) + 1;
  if (attempts > RETRY_MAX_ATTEMPTS) return null;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  return { ...entry, attempts, dueAt: now + delay };
};

// Deadlines by key, so a repeated touch of the same conversation replaces its
// entry instead of accumulating one per message.
export type Deadlines = Record<string, Deadline>;

export const DEADLINES_KEY = "deadlines";

// A conversation is considered idle one hour after its last accepted message.
export const IDLE_LEARN_MS = 60 * 60 * 1000;

export const deadlineKey = (
  reason: ScheduleReason,
  conversationId?: string,
): string => `${reason}:${conversationId ?? ""}`;

export const setDeadline = (
  deadlines: Deadlines,
  entry: Deadline,
): Deadlines => ({
  ...deadlines,
  [deadlineKey(entry.reason, entry.conversationId)]: entry,
});

// Split the set at `now`: what is due, and what remains pending.
export const dueDeadlines = (
  deadlines: Deadlines,
  now: number,
): { due: Deadline[]; remaining: Deadlines } => {
  const due: Deadline[] = [];
  const remaining: Deadlines = {};
  for (const [key, entry] of Object.entries(deadlines)) {
    if (entry.dueAt <= now) due.push(entry);
    else remaining[key] = entry;
  }
  return { due: due.sort((a, b) => a.dueAt - b.dueAt), remaining };
};

// The next deadline to arm the single alarm for, or null when nothing is
// pending.
export const earliestDueAt = (deadlines: Deadlines): number | null => {
  const times = Object.values(deadlines).map((d) => d.dueAt);
  return times.length === 0 ? null : Math.min(...times);
};

// The slice of DurableObjectStorage this module needs.
export interface ScheduleStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

const readDeadlines = async (storage: ScheduleStorage): Promise<Deadlines> =>
  (await storage.get<Deadlines>(DEADLINES_KEY)) ?? {};

// Record a deadline and arm the alarm for the earliest one. Always re-arms from
// the whole set rather than only the new entry: the alarm is a single slot, and
// an earlier deadline must not be pushed back by a later one.
export const scheduleDeadline = async (
  storage: ScheduleStorage,
  entry: Deadline,
): Promise<void> => {
  const deadlines = setDeadline(await readDeadlines(storage), entry);
  await storage.put(DEADLINES_KEY, deadlines);
  const next = earliestDueAt(deadlines);
  if (next !== null) await storage.setAlarm(next);
};

// Take everything due now, persist what is left, and re-arm for the next one.
// Returns the due entries for the caller to dispatch; dispatching is not this
// module's business.
export const takeDueDeadlines = async (
  storage: ScheduleStorage,
  now: number,
): Promise<Deadline[]> => {
  const { due, remaining } = dueDeadlines(await readDeadlines(storage), now);
  await storage.put(DEADLINES_KEY, remaining);
  const next = earliestDueAt(remaining);
  if (next === null) await storage.deleteAlarm();
  else await storage.setAlarm(next);
  return due;
};

// Put a failed deadline back, later, or give up on it. Re-arming by key means a
// fresh request for the same reason replaces the retry, which is what should
// happen: the newer request carries the newer intent.
//
// A give-up is the only reportable moment. Taking a deadline removed it, so
// once retries are exhausted the work is gone for good; the earlier attempts
// have lost nothing yet, and reporting them would create the issue on the first
// failure and hide the give-up behind it.
export const retryDispatch = async (deps: {
  storage: ScheduleStorage;
  entry: Deadline;
  // The error that failed this dispatch, carried through so a give-up is
  // reported with its cause rather than a synthetic message.
  err: unknown;
  now: number;
  reportError?: (err: unknown, context: Record<string, unknown>) => Promise<void>;
  clerkUserId?: string;
}): Promise<void> => {
  const { storage, entry, err, now } = deps;
  const next = retryDeadline(entry, now);
  if (next === null) {
    logScheduleGaveUp(entry);
    await deps.reportError?.(err, {
      site: "schedule_gave_up",
      reason: entry.reason,
      attempts: entry.attempts ?? 0,
      clerk_user_id: deps.clerkUserId,
    });
    return;
  }
  await scheduleDeadline(storage, next);
  logScheduleRetry(next, next.dueAt);
};

// Push a conversation's idle-learning deadline out to now + 1h. Called on every
// accepted user message, after the durable enqueue: an LLM failure must not make
// an active conversation look idle.
export const touchConversation = async (
  storage: ScheduleStorage,
  conversationId: string,
  now: number,
): Promise<void> =>
  scheduleDeadline(storage, {
    reason: "idle",
    conversationId,
    dueAt: now + IDLE_LEARN_MS,
  });

// The bit of ScheduleDO the turn path talks to. Narrow on purpose: a caller
// should not be able to reach anything else on the schedule.
export interface ScheduleTarget {
  touch(clerkUserId: string, conversationId: string): Promise<void>;
  requestLearn(
    clerkUserId: string,
    reason: "idle" | "size",
    conversationId?: string,
  ): Promise<void>;
}

// Push a conversation's idle deadline out, best-effort. A schedule that is
// unreachable must never reject the enqueue: losing the user's message to
// protect a learning timer would be the wrong trade, and the next message
// touches it again.
export const touchScheduleSafely = async (
  schedule: ScheduleTarget,
  clerkUserId: string,
  conversationId: string,
): Promise<void> => {
  try {
    await schedule.touch(clerkUserId, conversationId);
  } catch (err) {
    logError("schedule_touch_failed", { error: fmtErr(err) });
  }
};

// Ask for learning now, best-effort, for the same reason: a turn that has
// already answered the user must not fail because a timer could not be set.
export const requestLearnSafely = async (
  schedule: ScheduleTarget,
  clerkUserId: string,
  reason: "idle" | "size",
  conversationId?: string,
): Promise<void> => {
  try {
    await schedule.requestLearn(clerkUserId, reason, conversationId);
  } catch (err) {
    logError("schedule_request_failed", { reason, error: fmtErr(err) });
  }
};

// Log lines. `schedule_finished` matters by its absence: an alarm invocation
// killed at the 900s wall-time ceiling throws nothing, so a missing completion
// line is the only evidence (see docs/topics.md).
export const logScheduleFired = (entry: Deadline): void =>
  log("schedule_fired", {
    reason: entry.reason,
    has_conversation: entry.conversationId !== undefined,
    late_ms: Math.max(0, Date.now() - entry.dueAt),
  });

export const logScheduleRetry = (entry: Deadline, dueAt: number): void =>
  log("schedule_dispatch_retry", {
    reason: entry.reason,
    attempts: entry.attempts ?? 0,
    retry_in_ms: dueAt - Date.now(),
  });

export const logScheduleGaveUp = (entry: Deadline): void =>
  logError("schedule_dispatch_gave_up", {
    reason: entry.reason,
    attempts: entry.attempts ?? 0,
  });

export const logScheduleFinished = (input: {
  dispatched: number;
  durationMs: number;
}): void =>
  log("schedule_finished", {
    dispatched: input.dispatched,
    duration_ms: input.durationMs,
  });
