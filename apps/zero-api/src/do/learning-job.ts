// Learning-job state for LearningDO, kept free of the Durable Object so it is
// testable without one.
//
// One job runs at a time and one successor may be queued behind it. A request
// that arrives while a job is active is coalesced into that successor rather
// than starting a second job: the active job froze its input range at its start,
// so messages that arrived after it belong to the next job, not this one.

import { log } from "../log";

export type LearnReason = "idle" | "size";

export interface LearningJob {
  // Stable id for this job. It keys the frozen input range and the idempotent
  // completion on the UserDO side, so it must survive a restart of the job.
  id: string;
  reason: LearnReason;
  // The conversation a size-triggered job must also compact. Absent for idle.
  conversationId?: string;
  // Epoch ms the job was requested, for queue-age logging.
  requestedAt: number;
}

export interface LearningState {
  active: LearningJob | null;
  queued: LearningJob | null;
}

export const JOB_KEY = "learningJob";

export const EMPTY_STATE: LearningState = { active: null, queued: null };

// Merge a request into the state. Pure so the coalescing rule is testable:
//
// - nothing running: the request becomes the active job;
// - a job running, nothing queued: the request becomes the successor;
// - a job running and a successor queued: they merge. A `size` request wins over
//   `idle` and keeps its conversation id, because compaction is addressed to one
//   conversation and losing it would leave that conversation growing.
export const requestJob = (
  state: LearningState,
  request: LearningJob,
): { state: LearningState; coalesced: boolean; startNow: boolean } => {
  if (state.active === null) {
    return {
      state: { active: request, queued: state.queued },
      coalesced: false,
      startNow: true,
    };
  }
  if (state.queued === null) {
    return {
      state: { ...state, queued: request },
      coalesced: false,
      startNow: false,
    };
  }
  const queued =
    request.reason === "size"
      ? { ...request, requestedAt: state.queued.requestedAt }
      : state.queued;
  return { state: { ...state, queued }, coalesced: true, startNow: false };
};

// Finish the active job and promote any successor.
export const completeJob = (
  state: LearningState,
): { state: LearningState; next: LearningJob | null } => {
  const next = state.queued;
  return { state: { active: next, queued: null }, next };
};

export const logJobQueued = (input: {
  job: LearningJob;
  coalesced: boolean;
  successorPending: boolean;
}): void =>
  log("learning_job_queued", {
    reason: input.job.reason,
    coalesced: input.coalesced,
    successor_pending: input.successorPending,
  });
