// The "wake a sleeper" decision, kept free of the Durable Object so it is
// testable without one (same posture as do/mail-watch.ts).
//
// Reached by the `wake` deadline and by the admin backfill. The `wokeAt` marker
// on user_settings makes it self-dedupe regardless of trigger, so one message is
// sent per sleep episode. No model runs here: a wake queues a pending message
// and the turn happens on UserDO's own alarm, like any other message. See
// docs/wake-sleepers.md.

import { log } from "../log";
import { WAKE_INACTIVE_MS } from "./schedule";
import type { ConversationStore, SettingsStore } from "../store/types";

// The store surface a wake needs: settings (lastActiveAt / wokeAt), the
// most-recent-conversation lookup, and the pending queue the note goes into.
export interface WakeStore extends SettingsStore {
  getMostRecentConversation: ConversationStore["getMostRecentConversation"];
  enqueuePendingMessage(conversationId: string, content: string): void;
}

// Whether a message was queued, or why not.
export type WakeOutcome =
  | { status: "woken" }
  | { status: "skipped"; reason: "active" | "already_woken" | "no_conversation" };

// Apply the episode guard and, if it passes, mark wokeAt and queue the note.
// Does NOT arm the alarm or re-arm the wake deadline: the caller owns the alarm,
// and the user's next message re-arms the deadline.
export const runWake = (input: {
  store: WakeStore;
  now: number;
  // Wrap the wake note as the text of a turn (the WAKE_NOTE prefix).
  composeText: () => string;
}): WakeOutcome => {
  const { store, now } = input;
  const settings = store.getSettings();
  // A null lastActiveAt means the user never messaged: nothing to wake into.
  const lastActive = settings.lastActiveAt
    ? Date.parse(settings.lastActiveAt)
    : null;
  if (lastActive === null || now - lastActive < WAKE_INACTIVE_MS) {
    log("wake_skipped", { reason: "active" });
    return { status: "skipped", reason: "active" };
  }
  // Already nudged since the user last spoke: a repeated backfill or a duplicate
  // alarm must not re-nudge.
  if (settings.wokeAt && Date.parse(settings.wokeAt) > lastActive) {
    log("wake_skipped", { reason: "already_woken" });
    return { status: "skipped", reason: "already_woken" };
  }
  const conversation = store.getMostRecentConversation();
  if (!conversation) {
    log("wake_skipped", { reason: "no_conversation" });
    return { status: "skipped", reason: "no_conversation" };
  }
  // Mark before enqueue so a duplicate fire cannot double-nudge. The user's next
  // message moves lastActiveAt past this, re-enabling a future episode.
  store.updateSettings({ wokeAt: new Date(now).toISOString() });
  store.enqueuePendingMessage(conversation.id, input.composeText());
  log("wake_fired", {});
  return { status: "woken" };
};
