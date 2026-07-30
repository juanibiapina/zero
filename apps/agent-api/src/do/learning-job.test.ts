import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  completeJob,
  requestJob,
  type LearningState,
} from "./learning-job";

let ids = 0;
const job = (reason: "idle" | "size", conversationId?: string, at = 1) => ({
  id: `job_${++ids}`,
  reason,
  conversationId,
  requestedAt: at,
});

describe("requestJob", () => {
  it("starts a job when nothing is running", () => {
    const { state, startNow, coalesced } = requestJob(
      EMPTY_STATE,
      job("idle"),
    );
    expect(startNow).toBe(true);
    expect(coalesced).toBe(false);
    expect(state.active?.reason).toBe("idle");
    expect(state.queued).toBeNull();
  });

  it("queues a successor behind the active job instead of starting a second", () => {
    const running: LearningState = { active: job("idle"), queued: null };
    const { state, startNow } = requestJob(running, job("size", "c1", 5));
    expect(startNow).toBe(false);
    expect(state.active?.reason).toBe("idle");
    expect(state.queued).toMatchObject({ reason: "size", conversationId: "c1" });
  });

  it("coalesces further requests into the one successor", () => {
    const running: LearningState = { active: job("idle"), queued: job("idle", undefined, 5) };
    const { state, coalesced } = requestJob(running, job("idle", undefined, 9));
    expect(coalesced).toBe(true);
    expect(state.queued?.requestedAt).toBe(5);
  });

  it("lets a size request take over the successor and keep its conversation", () => {
    const running: LearningState = { active: job("idle"), queued: job("idle", undefined, 5) };
    const { state } = requestJob(running, job("size", "c1", 9));
    expect(state.queued).toMatchObject({
      reason: "size",
      conversationId: "c1",
      // The wait is measured from the first request that is still unanswered.
      requestedAt: 5,
    });
  });
});

describe("completeJob", () => {
  it("promotes the successor", () => {
    const { state, next } = completeJob({
      active: job("idle"),
      queued: job("size", "c1", 5),
    });
    expect(next).toMatchObject({ reason: "size" });
    expect(state.active).toMatchObject({ reason: "size" });
    expect(state.queued).toBeNull();
  });

  it("goes idle when there is no successor", () => {
    const { state, next } = completeJob({ active: job("idle"), queued: null });
    expect(next).toBeNull();
    expect(state).toEqual(EMPTY_STATE);
  });
});
