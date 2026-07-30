// LearningDO: one instance per user, owning the durable *execution* of learning
// jobs — job state, the learner's append-only wire log, and the alarm that
// advances a job one bounded slice at a time.
//
// It exists because `DurableObjectState.waitUntil` does not extend a Durable
// Object's lifetime: leaving a multi-minute promise behind after an RPC returns
// can simply lose the work. And it is separate from UserDO because a DO has one
// alarm: a learner that shared it would eventually sit in front of a reply.
//
// The slice contract, which is what makes a long job survivable:
//   - each alarm runs a bounded number of model steps;
//   - the learner's response is persisted before its tools run, and its results
//     before the next model call;
//   - an unfinished slice arms an immediate alarm and returns normally;
//   - an unexpected failure is left uncaught, so Cloudflare's alarm retry runs.
// A repeated topic write is harmless: it replays with the version it was based
// on, so it conflicts instead of duplicating.

import { DurableObject } from "cloudflare:workers";
import {
  completeJob,
  EMPTY_STATE,
  JOB_KEY,
  logJobQueued,
  requestJob,
  type LearnReason,
  type LearningJob,
  type LearningState,
} from "../do/learning-job";
import {
  appendWireLog,
  clearWireLog,
  readWireLog,
} from "../do/learning-log";
import {
  LEARN_STEPS_PER_SLICE,
  runLearnerSlice,
  summarizeConversation,
} from "../agents/learner";
import { usageLogFields } from "../agents/run";
import { createModel } from "../agents/model";
import { createRemoteLearningPort } from "../learning/remote-port";
import type { LearningPort } from "../learning/types";
import { getUserDO } from "../UserDO/stub";
import { log } from "../log";
import type { LearningMessage } from "../store/types";
import type { Env } from "../types";

// How many raw messages one job may consolidate, and the page size it reads
// them in. A job that would exceed the cap takes the oldest messages and leaves
// the rest to its successor, so no single job can grow without bound.
const MAX_JOB_MESSAGES = 400;
const MESSAGE_PAGE = 100;

// How much of a conversation compaction summarizes in one go.
const COMPACTION_CONTEXT_MESSAGES = 200;

export class LearningDO extends DurableObject<Env> {
  private async state(): Promise<LearningState> {
    return (await this.ctx.storage.get<LearningState>(JOB_KEY)) ?? EMPTY_STATE;
  }

  // Record a learning request. Short by contract: ScheduleDO calls this and
  // returns, so nothing awaits the learner's model calls.
  async request(
    clerkUserId: string,
    reason: LearnReason,
    conversationId?: string,
  ): Promise<void> {
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    const current = await this.state();
    const { state, coalesced } = requestJob(current, {
      id: crypto.randomUUID(),
      reason,
      conversationId,
      requestedAt: Date.now(),
    });
    await this.ctx.storage.put(JOB_KEY, state);
    if (state.active) {
      logJobQueued({
        job: state.active,
        coalesced,
        successorPending: state.queued !== null,
      });
    }
    // Arm whenever a job is active and no alarm is pending: that covers both a
    // fresh job and one whose alarm was lost to a failure.
    if (state.active && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const state = await this.state();
    const job = state.active;
    if (!job) {
      log("learn_skipped", { reason: "no_active_job" });
      return;
    }
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (!clerkUserId) {
      log("learn_skipped", { reason: "no_user" });
      await this.finishJob(state);
      return;
    }

    const port = createRemoteLearningPort(getUserDO(this.env, clerkUserId));
    // Frozen at the first slice and stable across restarts, so the prompt this
    // job was built from never widens under it.
    const highWaterMessageId = await port.beginJob(job.id);
    const messages = await this.pageMessages(port, highWaterMessageId);
    const wireLog = await readWireLog(this.ctx.storage);

    if (messages.length === 0 && wireLog.length === 0) {
      log("learn_skipped", { reason: "nothing_unconsolidated" });
      await this.completeAndFinish(port, job, state, startedAt, 0);
      return;
    }

    if (wireLog.length === 0) {
      log("learn_started", {
        reason: job.reason,
        unconsolidated_messages: messages.length,
        queue_age_ms: startedAt - job.requestedAt,
      });
    }

    const model = await createModel(this.env, clerkUserId, "learner");
    const slice = await runLearnerSlice({
      model,
      port,
      messages,
      wireLog,
      maxSteps: LEARN_STEPS_PER_SLICE,
      onAssistant: (content) =>
        appendWireLog(this.ctx.storage, { role: "assistant", content }),
      onToolResults: (results) =>
        appendWireLog(this.ctx.storage, { role: "user", content: results }),
    });

    log("learn_slice_completed", {
      reason: job.reason,
      model_steps: slice.steps,
      finished: slice.finished,
      duration_ms: Date.now() - startedAt,
      ...usageLogFields(slice.usage),
    });

    if (!slice.finished) {
      // Bounded slice, not a failure: come straight back and continue from the
      // persisted log.
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    if (job.reason === "size" && job.conversationId) {
      await this.compact(port, clerkUserId, job.conversationId);
    }
    await this.completeAndFinish(port, job, state, startedAt, messages.length);
  }

  // Read the job's raw input, bounded. A job that hits the cap leaves the rest
  // for its successor rather than growing without limit.
  private async pageMessages(
    port: LearningPort,
    throughMessageId: number,
  ): Promise<LearningMessage[]> {
    const out: LearningMessage[] = [];
    let afterId = 0;
    while (out.length < MAX_JOB_MESSAGES) {
      const page = await port.listMessages({
        throughMessageId,
        afterId,
        limit: MESSAGE_PAGE,
      });
      if (page.length === 0) break;
      out.push(...page);
      afterId = page[page.length - 1].id;
      if (page.length < MESSAGE_PAGE) break;
    }
    return out.slice(0, MAX_JOB_MESSAGES);
  }

  // Replace one conversation's early history with prose. Non-destructive: the
  // raw rows stay, only the boundary moves, because the raw log is what learning
  // reads.
  private async compact(
    port: LearningPort,
    clerkUserId: string,
    conversationId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const context = await port.getContext(
      conversationId,
      COMPACTION_CONTEXT_MESSAGES,
    );
    // Keep the newest exchange out of the summary: the user is mid-conversation
    // and the last messages are the ones they are still talking about.
    const compacted = context.messages.slice(0, -4);
    if (compacted.length === 0) {
      log("learn_skipped", { reason: "nothing_to_compact" });
      return;
    }
    const model = await createModel(this.env, clerkUserId, "compaction");
    const { summary, usage } = await summarizeConversation({
      model,
      summary: context.summary,
      messages: compacted,
    });
    if (summary === "") {
      log("learn_skipped", { reason: "empty_summary" });
      return;
    }
    const throughMessageId = compacted[compacted.length - 1].id;
    await port.compactConversation(conversationId, {
      throughMessageId,
      summary,
    });
    log("compaction_completed", {
      messages_compacted: compacted.length,
      summary_chars: summary.length,
      duration_ms: Date.now() - startedAt,
      ...usageLogFields(usage),
    });
  }

  private async completeAndFinish(
    port: LearningPort,
    job: LearningJob,
    state: LearningState,
    startedAt: number,
    consolidated: number,
  ): Promise<void> {
    // Stamp the covered messages. Idempotent by job id, and it does not touch
    // the knowledge version: the topic writes already advanced it.
    await port.completeJob(job.id);
    log("learn_completed", {
      reason: job.reason,
      messages_consolidated: consolidated,
      duration_ms: Date.now() - startedAt,
    });
    await this.finishJob(state);
  }

  // Close the active job, promote any successor, and start it immediately.
  private async finishJob(state: LearningState): Promise<void> {
    await clearWireLog(this.ctx.storage);
    const { state: next, next: successor } = completeJob(state);
    await this.ctx.storage.put(JOB_KEY, next);
    if (successor !== null) await this.ctx.storage.setAlarm(Date.now());
  }
}
