// Google onboarding orchestration, extracted from UserDO so the status state
// machine is testable without a Durable Object (mirrors do/alarm.ts).
//
// Durability trick: never move to a transient "running" state. The caller runs
// this only while the status is "queued"; on success we flip to "done", and a
// caught failure flips to "failed" (logged, not retried in a loop). A mid-run
// DO eviction skips the catch and leaves the status "queued", so the next alarm
// re-runs it. Re-running is idempotent: it re-authors the same pinned topic.

import { logError, fmtErr } from "../log";
import type { TopicStore } from "../store/types";

export interface OnboardingDeps {
  store: TopicStore;
  // The pinned identity topic to ensure + fill.
  topicName: string;
  description: string;
  // Run the onboarding agent against the (already created + pinned) topic.
  // Injected so tests need no model/Google; production wires runOnboardingAgent
  // with a per-user model and memoized Google token.
  runAgent: (topicName: string) => Promise<void>;
  // Persist the terminal status ("done" | "failed").
  setStatus: (status: string) => void;
}

export const runOnboarding = async (deps: OnboardingDeps): Promise<void> => {
  const { store, topicName, description, runAgent, setStatus } = deps;

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
  } catch (err) {
    logError("onboarding_failed", { error: fmtErr(err) });
    setStatus("failed");
  }
};
