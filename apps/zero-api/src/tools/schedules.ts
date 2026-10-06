// create_schedule / list_schedules / cancel_schedule for the interface agent.
// They are the user's "remind me at 6" and "every weekday at 8, send me my
// calendar": a schedule stores an instruction to Zero's future self, and when
// it comes due that instruction is answered as an ordinary turn in this thread.
//
// The tools see only the ScheduleBook port — no SQLite, no croner, no
// ScheduleDO, no chat id. Times are rendered here, in the schedule's own zone,
// so the model never does date math.

import { z } from "zod";
import { defineTool, type AgentToolSet } from "../agents/protocol";
import { describe, formatLocal } from "../schedules/recurrence";
import type { Schedule, ScheduleBook } from "../schedules/types";

export interface ScheduleToolDeps {
  // Absent in contexts without user storage (tests): the tools then report they
  // cannot schedule rather than lying. They stay registered either way, so the
  // tool schema is byte-identical across users and turns (see docs/caching.md).
  schedules?: ScheduleBook;
  // Default zone for a create, from the user's settings. Falls back to UTC.
  timezone?: string;
  // Re-arm the user's timer after a change. Fire-and-forget: a timer that
  // cannot be armed must not fail the user's turn.
  onScheduleChanged?: () => void;
}

const NO_BOOK = "Can't manage schedules in this context.";

const render = (schedule: Schedule) => ({
  id: schedule.id,
  prompt: schedule.prompt,
  description: describe(schedule.pattern, schedule.timezone),
  nextRun:
    schedule.nextDueAt === null
      ? null
      : formatLocal(schedule.nextDueAt, schedule.timezone),
  timezone: schedule.timezone,
});

export const buildScheduleTools = (deps: ScheduleToolDeps): AgentToolSet => {
  const { schedules, timezone = "UTC", onScheduleChanged } = deps;

  return {
    create_schedule: defineTool({
      description:
        "Schedule something for later: a one-off reminder or a repeating task. " +
        "Only when the user asks for it. `prompt` is an instruction to yourself " +
        "for when it fires, not a message to the user (e.g. \"remind the user to " +
        'call Ana", "send today\'s calendar and unread mail"): you will run a ' +
        "full turn with your tools and message the user in this chat. `pattern` " +
        'is either a five-field cron expression ("0 8 * * 1-5" = every weekday ' +
        'at 08:00) or an ISO-8601 local datetime for a one-off ' +
        '("2026-08-05T18:00:00"). Resolve what the user said against the current ' +
        "time before calling. Confirm the returned time back to the user in their " +
        "own words.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe("What you should do when this fires, addressed to yourself"),
        pattern: z
          .string()
          .describe('Cron expression, or ISO-8601 local datetime for a one-off'),
        timezone: z
          .string()
          .optional()
          .describe("IANA zone; defaults to the user's own"),
      }),
      execute: async (input) => {
        if (!schedules) return { error: NO_BOOK };
        const result = await schedules.create({
          prompt: input.prompt,
          pattern: input.pattern,
          timezone: input.timezone ?? timezone,
        });
        if ("error" in result) {
          return {
            error: result.error,
            ...(result.suggestions ? { suggestions: result.suggestions } : {}),
          };
        }
        onScheduleChanged?.();
        return render(result.schedule);
      },
    }),

    list_schedules: defineTool({
      description:
        "List what is scheduled in this chat, with the next time each one runs. " +
        "Use it when the user asks what you have scheduled, or to find the id of " +
        "the one they want cancelled.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!schedules) return { error: NO_BOOK };
        return { schedules: (await schedules.list()).map(render) };
      },
    }),

    cancel_schedule: defineTool({
      description:
        "Cancel a schedule by id. Get the id from list_schedules. To change a " +
        "schedule, cancel it and create the new one.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        if (!schedules) return { error: NO_BOOK };
        if (!(await schedules.cancel(id))) {
          return { error: `No active schedule with id ${id}.` };
        }
        onScheduleChanged?.();
        return { cancelled: true, id };
      },
    }),
  };
};
