// Google onboarding orchestration, extracted from UserDO so the status state
// machine is testable without a Durable Object (mirrors do/alarm.ts).
//
// Durability trick: never move to a transient "running" state. The caller runs
// this only while the status is "queued"; on success we flip to "done", and a
// caught failure flips to "failed" (logged, not retried in a loop). A mid-run
// DO eviction skips the catch and leaves the status "queued", so the next alarm
// re-runs it. Re-running is idempotent: it re-authors the same pinned topic.

import { log, logError, fmtErr } from "../log";
import type { TopicStore } from "../store/types";

export interface OnboardingDeps {
  store: TopicStore;
  // Logged and reported on every boundary, so an onboarding run is joinable
  // with the `onboarding_queued` line the route emits.
  clerkUserId: string;
  // The pinned identity topic to ensure + fill.
  topicName: string;
  description: string;
  // Run the onboarding agent against the (already created + pinned) topic.
  // Injected so tests need no model/Google; production wires runOnboardingAgent
  // with a per-user model and memoized Google token.
  runAgent: (topicName: string) => Promise<void>;
  // Persist the terminal status ("done" | "failed").
  setStatus: (status: string) => void;
  // Report the run's boundaries to a human channel (production: Discord).
  // Injected so this module stays free of env and fetch.
  notify: (message: string) => Promise<void>;
  // Report a failed run to ZeroErrors. Optional and injected by the DO, same
  // shape as `notify`: the failure leaves the user without the identity topic
  // they were promised, so it is a defect, not a log line.
  reportError?: (err: unknown) => Promise<void>;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

// A notification must never change the outcome of a run: production's
// `notifyDiscord` already swallows its own errors, this guards the seam.
const safeNotify = async (
  notify: (message: string) => Promise<void>,
  message: string,
): Promise<void> => {
  try {
    await notify(message);
  } catch (err) {
    logError("onboarding_notify_failed", { error: fmtErr(err) });
  }
};

export const runOnboarding = async (deps: OnboardingDeps): Promise<void> => {
  const { store, clerkUserId, topicName, description, runAgent, setStatus } =
    deps;

  // Boundary logging. `onboarding_started` matters by the absence of its
  // terminal partner: a mid-run DO eviction skips the catch below, so a start
  // line with no `onboarding_finished` / `onboarding_failed` is the only
  // evidence that the run died with the status left at "queued".
  const startedAt = Date.now();
  log("onboarding_started", { clerk_user_id: clerkUserId });
  await safeNotify(deps.notify, `🔍 Onboarding started: ${clerkUserId}`);

  // Pre-create and pin the topic before the agent fills it. Idempotent across
  // re-runs: create only when absent, always (re-)assert the pin.
  // The body starts empty: the agent fills it with append_topic. Each write
  // states the version it read, and only a real change is written, so a re-run
  // does not invalidate every persisted topic read for nothing.
  const existing = store.getTopic(topicName);
  if (!existing) {
    store.createTopic({
      expectedVersion: store.getKnowledgeVersion(),
      name: topicName,
      description,
      body: "",
    });
  }
  if (!store.getTopic(topicName)?.pinned) {
    store.setPinned({
      expectedVersion: store.getKnowledgeVersion(),
      name: topicName,
      pinned: true,
    });
  }

  try {
    await runAgent(topicName);
    setStatus("done");
    const durationMs = Date.now() - startedAt;
    log("onboarding_finished", {
      clerk_user_id: clerkUserId,
      status: "done",
      duration_ms: durationMs,
    });
    await safeNotify(
      deps.notify,
      `✅ Onboarding done: ${clerkUserId} (${secs(durationMs)})`,
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const formatted = fmtErr(err);
    logError("onboarding_failed", {
      clerk_user_id: clerkUserId,
      duration_ms: durationMs,
      error: formatted,
    });
    setStatus("failed");
    await deps.reportError?.(err);
    await safeNotify(
      deps.notify,
      `❌ Onboarding failed: ${clerkUserId} (${secs(durationMs)}) — ${formatted.message.slice(0, 200)}`,
    );
  }
};
