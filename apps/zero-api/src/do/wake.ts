// The "wake a sleeper" decision, kept free of the Durable Object so it is
// testable without one (same posture as do/mail-watch.ts).
//
// Reached by the `wake` deadline and by the admin backfill. The `wokeAt` marker
// on user_settings makes it self-dedupe regardless of trigger, so one message is
// sent per sleep episode, and the submission is keyed on the sleep episode so a
// retry between the two is answered once. See docs/wake-sleepers.md.

import { log } from "../log";
import { WAKE_INACTIVE_MS } from "./schedule";
import type { SettingsStore, Thread } from "../store/types";

export type WakeOutcome =
  | { status: "woken" }
  | { status: "skipped"; reason: "active" | "already_woken" | "no_conversation" };

export const runWake = async (input: {
  store: SettingsStore;
  conversation: Thread | null;
  now: number;
  composeText: () => string;
  submit: (conversationId: string, text: string, operationId: string) => Promise<void>;
}): Promise<WakeOutcome> => {
  const { store, now, conversation } = input;
  const settings = store.getSettings();
  const lastActive = settings.lastActiveAt
    ? Date.parse(settings.lastActiveAt)
    : null;
  if (lastActive === null || now - lastActive < WAKE_INACTIVE_MS) {
    log("wake_skipped", { reason: "active" });
    return { status: "skipped", reason: "active" };
  }
  if (settings.wokeAt && Date.parse(settings.wokeAt) > lastActive) {
    log("wake_skipped", { reason: "already_woken" });
    return { status: "skipped", reason: "already_woken" };
  }
  if (!conversation) {
    log("wake_skipped", { reason: "no_conversation" });
    return { status: "skipped", reason: "no_conversation" };
  }
  await input.submit(conversation.id, input.composeText(), `wake:${settings.lastActiveAt}`);
  store.updateSettings({ wokeAt: new Date(now).toISOString() });
  log("wake_fired", {});
  return { status: "woken" };
};
