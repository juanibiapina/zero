// ScheduleDO: one instance per user, owning every deadline for that user — idle
// learning, size-triggered learning, and later the onboarding and admin-task
// timers that still sit on UserDO's alarm.
//
// It owns *when*, never the work itself. A due learning deadline is handed to
// LearningDO through a short RPC and this invocation ends; it never awaits a
// learner's model calls. That separation is the point: UserDO's alarm stays
// dedicated to draining turns, so nothing a schedule or a learner does can delay
// a reply.

import { DurableObject } from "cloudflare:workers";
import {
  logScheduleFinished,
  logScheduleFired,
  scheduleDeadline,
  takeDueDeadlines,
  touchConversation,
} from "../do/schedule";
import type { LearnReason } from "../do/learning-job";
import { getLearningDO } from "../LearningDO/stub";
import { getUserDO } from "../UserDO/stub";
import { logError, fmtErr } from "../log";
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

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const due = await takeDueDeadlines(this.ctx.storage, startedAt);
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    let dispatched = 0;
    for (const entry of due) {
      logScheduleFired(entry);
      if (!clerkUserId) continue;
      try {
        await this.dispatch(clerkUserId, entry.reason, entry.conversationId);
        dispatched++;
      } catch (err) {
        // One unreachable target must not take the whole schedule down, and must
        // not lose the other due deadlines in this invocation.
        logError("schedule_dispatch_failed", {
          reason: entry.reason,
          error: fmtErr(err),
        });
      }
    }
    logScheduleFinished({ dispatched, durationMs: Date.now() - startedAt });
  }

  // Hand the work to whoever owns it. Learning goes to LearningDO, which
  // persists the request and returns; the two user-wide jobs go to their
  // existing UserDO entry points. Nothing here awaits an agent loop except those
  // UserDO calls, which are the jobs themselves.
  private async dispatch(
    clerkUserId: string,
    reason: "idle" | "size" | "onboarding" | "admin_task",
    conversationId?: string,
  ): Promise<void> {
    if (reason === "idle" || reason === "size") {
      await getLearningDO(this.env, clerkUserId).request(reason, conversationId);
      return;
    }
    const userDO = getUserDO(this.env, clerkUserId);
    if (reason === "onboarding") await userDO.runQueuedOnboarding();
    else await userDO.runQueuedAdminTask();
  }
}
