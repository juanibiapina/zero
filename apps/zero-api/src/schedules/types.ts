import type { Awaitable } from "../awaitable";

// The schedule port the agent tools are written against. It carries no SQLite,
// no croner, no Durable Object and no chat id: a tool can create, list and
// cancel, and nothing else.

export interface Schedule {
  // Short and nameable, so the user and the model can refer to one: "sch_7f3a".
  id: string;
  // An instruction to Zero's future self, not user-facing copy.
  prompt: string;
  // Five-field cron expression or ISO-8601 local datetime.
  pattern: string;
  timezone: string;
  // Epoch ms of the next fire, null once retired.
  nextDueAt: number | null;
  createdAt: string;
  lastFiredAt: string | null;
}

// Why a create was refused, for the log line. `pattern` also covers a one-shot
// in the past; `cap` is the per-user ceiling on active schedules.
export type ScheduleRejection = "pattern" | "timezone" | "cap";

export type CreateScheduleResult =
  | { schedule: Schedule }
  | { error: string; reason: ScheduleRejection; suggestions?: string[] };

export interface ScheduleBook {
  create(input: {
    prompt: string;
    pattern: string;
    timezone: string;
  }): Awaitable<CreateScheduleResult>;
  list(): Awaitable<Schedule[]>;
  // False when no active schedule has this id (unknown, or already cancelled).
  cancel(id: string): Awaitable<boolean>;
}
