// LearningDO: one instance per user, owning the durable *execution* of learning
// jobs — job state, the learner's message log, checkpoints and retry progress
// (Phase 3). It exists because `DurableObjectState.waitUntil` does not extend a
// Durable Object's lifetime: leaving a multi-minute promise behind after an RPC
// returns can simply lose the work. A job therefore needs an object whose own
// alarm advances it.
//
// Today it is a shell: it records and coalesces requests so the trigger path can
// be wired and observed, and its alarm reports that no executor is enabled yet.
// The per-turn writer still does the consolidating until the Phase 3.4
// activation, so a request with no executor is a no-op, not lost work.

import { DurableObject } from "cloudflare:workers";
import {
  completeJob,
  EMPTY_STATE,
  JOB_KEY,
  logJobQueued,
  requestJob,
  type LearnReason,
  type LearningState,
} from "../do/learning-job";
import { log } from "../log";
import type { Env } from "../types";

export class LearningDO extends DurableObject<Env> {
  private async state(): Promise<LearningState> {
    return (await this.ctx.storage.get<LearningState>(JOB_KEY)) ?? EMPTY_STATE;
  }

  // Record a learning request. Short by contract: ScheduleDO calls this and
  // returns, so nothing awaits the learner's model calls.
  async request(reason: LearnReason, conversationId?: string): Promise<void> {
    const current = await this.state();
    const { state, coalesced, startNow } = requestJob(current, {
      reason,
      conversationId,
      requestedAt: Date.now(),
    });
    await this.ctx.storage.put(JOB_KEY, state);
    logJobQueued({
      job: state.active ?? state.queued ?? { reason, requestedAt: Date.now() },
      coalesced,
      successorPending: state.queued !== null,
    });
    if (startNow && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const current = await this.state();
    if (current.active === null) {
      log("learn_skipped", { reason: "no_active_job" });
      return;
    }
    // Phase 3 puts the checkpointed learner loop here. Until then the per-turn
    // writer is still what consolidates topics, so the honest thing is to drop
    // the job and say so rather than to half-run one.
    log("learn_skipped", {
      reason: "executor_not_enabled",
      trigger: current.active.reason,
      queue_age_ms: startedAt - current.active.requestedAt,
    });
    const { state, next } = completeJob(current);
    await this.ctx.storage.put(JOB_KEY, state);
    if (next !== null) await this.ctx.storage.setAlarm(Date.now());
  }
}
