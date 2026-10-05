// ScheduleDO: one instance per user, owning every deadline for that user — idle
// and size-triggered learning, Google onboarding, admin tasks, and the
// schedules the user set themselves (see docs/schedules.md).
//
// It owns *when*, never the work itself. Each due deadline is handed to
// whichever object owns it (see dispatch.ts) and this invocation ends; it never
// awaits a learner's model calls. That separation is the point: UserDO's alarm
// stays dedicated to draining turns, so nothing a schedule or a learner does can
// delay a reply.

import { DurableObject } from "cloudflare:workers";
import { dispatchFor } from "./dispatch";
import {
  logScheduleFinished,
  logScheduleFired,
  retryDispatch,
  scheduleDeadline,
  takeDueDeadlines,
  touchConversation,
} from "../do/schedule";
import type { LearnReason } from "../do/learning-job";
import { logError, fmtErr } from "../log";
import { reportError } from "../reporting/zero-errors";
import type { Env } from "../types";

export class ScheduleDO extends DurableObject<Env> {
  // Push this conversation's idle-learning deadline to now + 1h. Called after a
  // user message is durably queued.
  async touch(clerkUserId: string, conversationId: string): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await touchConversation(this.ctx.storage, conversationId, Date.now());
  }

  // Ask for learning as soon as possible (the size trigger). The deadline is
  // due immediately; dispatch still goes through the alarm so there is one path
  // to LearningDO.
  async requestLearn(
    clerkUserId: string,
    reason: LearnReason,
    conversationId?: string,
  ): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await scheduleDeadline(this.ctx.storage, {
      reason,
      conversationId,
      dueAt: Date.now(),
    });
  }

  // Ask for one of the user-wide jobs (Google onboarding, an admin task) as soon
  // as possible. They used to share UserDO's alarm with turn draining, which is
  // exactly what delayed replies; the deadline lives here and the job still runs
  // through its existing UserDO entry point.
  async requestJob(
    clerkUserId: string,
    reason: "onboarding" | "admin_task",
  ): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await scheduleDeadline(this.ctx.storage, { reason, dueAt: Date.now() });
  }

  // Hold this user's schedule deadline at `dueAt`. There is exactly one such
  // deadline, and `scheduleDeadline` replaces by key, so the caller must always
  // pass the EARLIEST pending due time: a later one would push the alarm past
  // a schedule that is due sooner. UserDO computes it from the store, which is
  // the only place that knows.
  async requestReminderAt(clerkUserId: string, dueAt: number): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await scheduleDeadline(this.ctx.storage, { reason: "reminder", dueAt });
  }

  // Hold this user's mail poll at `dueAt`. One deadline per user, replaced by
  // key: the poll re-arms itself every hour, and a user's message re-arms it
  // after a gap, so a second entry must never accumulate.
  async requestMailWatchAt(clerkUserId: string, dueAt: number): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await scheduleDeadline(this.ctx.storage, { reason: "mailwatch", dueAt });
  }

  // Hold this user's wake deadline at `dueAt`. One per user, replaced by key:
  // every message re-arms it a week out, so a talking user is never woken, and a
  // second entry must never accumulate (see docs/wake-sleepers.md).
  async requestWakeAt(clerkUserId: string, dueAt: number): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await scheduleDeadline(this.ctx.storage, { reason: "wake", dueAt });
  }

  // Drop every deadline this user has, and the alarm that would fire them.
  // Called when the user erases their data (see do/purge.ts): a pending
  // deadline exists only to call back into UserDO, so it must not survive the
  // object it would call. Leaves the storage empty so the object costs nothing.
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const due = await takeDueDeadlines(this.ctx.storage, startedAt);
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    let dispatched = 0;
    for (const entry of due) {
      logScheduleFired(entry);
      if (!clerkUserId) continue;
      const dispatch = dispatchFor(entry.reason);
      if (!dispatch) {
        logError("schedule_unknown_reason", { reason: entry.reason });
        continue;
      }
      try {
        await dispatch({
          env: this.env,
          clerkUserId,
          conversationId: entry.conversationId,
        });
        dispatched++;
      } catch (err) {
        // One unreachable target must not take the whole schedule down, and must
        // not lose the other due deadlines in this invocation.
        logError("schedule_dispatch_failed", {
          reason: entry.reason,
          error: fmtErr(err),
        });
        // Taking a deadline removed it, so a failure here would drop the work
        // for good. Learning comes back on the user's next message, but nothing
        // else re-requests onboarding or an admin task: put the entry back with
        // a backoff instead.
        await retryDispatch({
          storage: this.ctx.storage,
          entry,
          err,
          now: Date.now(),
          clerkUserId,
          reportError: (reported, context) =>
            reportError(this.env, reported, context),
        });
      }
    }
    logScheduleFinished({ dispatched, durationMs: Date.now() - startedAt });
  }
}
