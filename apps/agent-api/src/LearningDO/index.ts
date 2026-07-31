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
  renderLearningLog,
  runLearnerSlice,
  summarizeConversation,
} from "../agents/learner";
import { usageLogFields } from "../agents/run";
import { createModel } from "../agents/model";
import { createRemoteLearningPort } from "../learning/remote-port";
import type { LearningPort } from "../learning/types";
import { getUserDO } from "../UserDO/stub";
import { log } from "../log";
import { reportError } from "../reporting/zero-errors";
import { estimateTokens, safeCompactionCut } from "../store/messages";
import type { LearningMessage } from "../store/types";
import type { Env } from "../types";

// How much raw input one job may consolidate, and the page size it reads it in.
//
// The bound is rendered size, not a message count: every message this job takes
// goes into a single learner prompt (renderLearningLog), and 400 tool-heavy
// messages and 400 one-line messages differ by an order of magnitude there. A
// job that would exceed the budget takes the oldest messages that fit and
// leaves the rest to its successor.
//
// The number is a guess, like the compaction threshold. It is well under the
// context window on purpose; `learn_started.input_tokens` from real jobs is what
// must move it.
const LEARN_JOB_BUDGET_TOKENS = 40_000;
const MESSAGE_PAGE = 100;
// Second backstop so a pathological row (or a bug in the estimate) cannot make
// one job read the whole table. Not the primary bound.
const MAX_JOB_MESSAGES = 2_000;

// How many rows one compaction pass reads, counted forward from the boundary.
const COMPACTION_WINDOW_MESSAGES = 200;
// Rows held out of the summary on the pass that reaches the tail: the user is
// mid-conversation and those are the messages they are still talking about.
const COMPACTION_KEEP_TAIL = 4;

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

  // Report an unexpected slice failure, then let it out. Cloudflare's alarm
  // retry is what makes a long job survivable, so the throw must still escape;
  // the report only gives the failure a name. Retries fingerprint to the same
  // issue, so one bad job is one issue with several events.
  override async alarm(): Promise<void> {
    try {
      await this.runSlice();
    } catch (err) {
      const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
      await reportError(this.env, err, {
        site: "learning",
        clerk_user_id: clerkUserId,
      });
      throw err;
    }
  }

  private async runSlice(): Promise<void> {
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
    const page = await this.pageMessages(port, highWaterMessageId);
    const messages = page.messages;
    const wireLog = await readWireLog(this.ctx.storage);

    if (messages.length === 0 && wireLog.length === 0) {
      log("learn_skipped", { reason: "nothing_unconsolidated" });
      await this.completeAndFinish(port, job, state, startedAt, {
        consolidated: 0,
        throughMessageId: highWaterMessageId,
      });
      return;
    }

    if (wireLog.length === 0) {
      log("learn_started", {
        reason: job.reason,
        unconsolidated_messages: messages.length,
        input_tokens: page.tokens,
        truncated: page.truncated,
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

    // A job stamps only what it was shown. The rest of its frozen range, and
    // anything compaction could not reach in one window, go to a successor.
    let compactionRemains = false;
    if (job.reason === "size" && job.conversationId) {
      compactionRemains = await this.compact(
        port,
        clerkUserId,
        job.conversationId,
      );
    }
    await this.completeAndFinish(port, job, state, startedAt, {
      consolidated: messages.length,
      throughMessageId: page.truncated
        ? messages[messages.length - 1].id
        : highWaterMessageId,
    });
    if (compactionRemains && job.conversationId) {
      await this.request(clerkUserId, "size", job.conversationId);
    } else if (page.truncated) {
      await this.request(clerkUserId, "idle");
    }
  }

  // Read the job's raw input, bounded by what the learner's prompt can hold.
  // Stops on the first message that would push the rendered log past the budget
  // and reports `truncated`, so completion stamps only what was read and the
  // remainder goes to a successor.
  private async pageMessages(
    port: LearningPort,
    throughMessageId: number,
  ): Promise<{
    messages: LearningMessage[];
    tokens: number;
    truncated: boolean;
  }> {
    const out: LearningMessage[] = [];
    let tokens = 0;
    let afterId = 0;
    let truncated = false;
    while (out.length < MAX_JOB_MESSAGES && !truncated) {
      const page = await port.listMessages({
        throughMessageId,
        afterId,
        limit: MESSAGE_PAGE,
      });
      if (page.length === 0) break;
      for (const message of page) {
        const cost = estimateTokens(renderLearningLog([message]).length);
        // Always take the first message: a single oversized row must not make
        // the job read nothing and stall the range forever.
        if (out.length > 0 && tokens + cost > LEARN_JOB_BUDGET_TOKENS) {
          truncated = true;
          break;
        }
        out.push(message);
        tokens += cost;
      }
      afterId = page[page.length - 1].id;
      if (page.length < MESSAGE_PAGE) break;
    }
    return {
      messages: out,
      tokens,
      truncated: truncated || out.length === MAX_JOB_MESSAGES,
    };
  }

  // Replace one conversation's early history with prose. Non-destructive: the
  // raw rows stay, only the boundary moves, because the raw log is what learning
  // reads.
  //
  // Returns whether rows are left over: the window pages forward from the
  // boundary, so a long conversation takes several passes and each one must
  // hand the rest to a successor. Reading the tail instead would let the
  // boundary jump over everything in between, which no summary would ever
  // cover.
  private async compact(
    port: LearningPort,
    clerkUserId: string,
    conversationId: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const window = await port.getCompactionWindow(
      conversationId,
      COMPACTION_WINDOW_MESSAGES,
    );
    // The boundary may only land after a terminal assistant response, so what
    // survives it starts on a user message. A row-count cut can fall between an
    // assistant tool call and its result and leave a context the API rejects.
    const cut = safeCompactionCut(window.messages, {
      keepTail: window.hasMore ? 0 : COMPACTION_KEEP_TAIL,
    });
    if (cut === null) {
      log("learn_skipped", { reason: "nothing_to_compact" });
      return false;
    }
    const compacted = window.messages.slice(0, cut + 1);
    const model = await createModel(
      this.env,
      clerkUserId,
      "compaction",
      undefined,
      { conversationId },
    );
    const { summary, usage } = await summarizeConversation({
      model,
      summary: window.summary,
      messages: compacted,
    });
    if (summary === "") {
      log("learn_skipped", { reason: "empty_summary" });
      return false;
    }
    const throughMessageId = compacted[compacted.length - 1].id;
    await port.compactConversation(conversationId, {
      throughMessageId,
      summary,
    });
    log("compaction_completed", {
      messages_compacted: compacted.length,
      summary_chars: summary.length,
      has_more: window.hasMore,
      duration_ms: Date.now() - startedAt,
      ...usageLogFields(usage),
    });
    return window.hasMore;
  }

  private async completeAndFinish(
    port: LearningPort,
    job: LearningJob,
    state: LearningState,
    startedAt: number,
    covered: { consolidated: number; throughMessageId: number },
  ): Promise<void> {
    // Stamp what the learner was actually shown, never the whole frozen range:
    // a truncated job that stamped its high-water mark would mark messages
    // nobody read as learned, permanently. Idempotent by job id, and it does not
    // touch the knowledge version: the topic writes already advanced it.
    await port.completeJob(job.id, covered.throughMessageId);
    log("learn_completed", {
      reason: job.reason,
      messages_consolidated: covered.consolidated,
      through_message_id: covered.throughMessageId,
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
