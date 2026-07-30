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

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const due = await takeDueDeadlines(this.ctx.storage, startedAt);
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    let dispatched = 0;
    for (const entry of due) {
      logScheduleFired(entry);
      if (entry.reason !== "idle" && entry.reason !== "size") continue;
      if (!clerkUserId) continue;
      try {
        await getLearningDO(this.env, clerkUserId).request(
          entry.reason,
          entry.conversationId,
        );
        dispatched++;
      } catch (err) {
        // A learner that cannot be reached must not take the schedule down: the
        // next deadline for this conversation will ask again.
        logError("schedule_dispatch_failed", {
          reason: entry.reason,
          error: fmtErr(err),
        });
      }
    }
    logScheduleFinished({ dispatched, durationMs: Date.now() - startedAt });
  }
}
