// The hourly "did anyone reply?" pass, kept free of the Durable Object so it is
// testable without one (same posture as do/schedules.ts).
//
// One Gmail call covers every watched thread, because Gmail's history is a
// MAILBOX log: the watermark is a single value on the user's settings, not one
// per thread. Every successful pass advances it whether or not anything
// matched, which is what keeps a thread that has been quiet for months inside
// Gmail's retention window and therefore still watchable.
//
// No model runs here. A hit queues a pending message and the turn happens on
// UserDO's own alarm, like any other message.

import { log } from "../log";
import { GoogleNotConnectedError, GoogleApiError } from "../google/types";
import type { MailApi } from "../google/types";
import type { MailThreadStore, SettingsStore } from "../store/types";

// How long between passes. One hour is the promise: a reply is announced within
// the hour, at the cost of one Gmail call per active watching user per hour.
export const MAIL_WATCH_INTERVAL_MS = 60 * 60 * 1000;

// A user who has not written to Zero in this long stops being polled at all.
// Their watched threads stay; the next message they send re-arms the pass.
export const MAIL_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000;

// Ceiling on watched threads per user. Each one is a candidate turn.
export const MAX_WATCHED_THREADS = 50;

// The store surface a pass needs: the watched rows, the watermark (settings)
// and the pending queue the notifications go into.
export interface MailWatchStore extends MailThreadStore, SettingsStore {
  enqueuePendingMessage(conversationId: string, content: string): void;
}

// Why a pass did not arm the next one, or what it did instead.
export type MailWatchOutcome =
  | { status: "disarmed"; reason: "no_threads" | "inactive" | "not_connected" }
  | { status: "rebaselined" }
  | { status: "checked"; notified: number };

export const runMailWatch = async (input: {
  store: MailWatchStore;
  mail: Pick<MailApi, "getWatermark" | "listChangedThreads">;
  now: number;
  // Wrap a thread id as the text of a turn (the MAIL_NOTE prefix).
  composeText: (threadId: string) => string;
}): Promise<MailWatchOutcome> => {
  const { store, mail, now } = input;

  const watched = store.listMailThreads();
  if (watched.length === 0) return disarm("no_threads");

  const settings = store.getSettings();
  const lastActiveAt = settings.lastActiveAt
    ? Date.parse(settings.lastActiveAt)
    : null;
  if (lastActiveAt === null || now - lastActiveAt > MAIL_INACTIVE_MS) {
    return disarm("inactive");
  }

  try {
    // No watermark yet: start from now. Replaying the mailbox's past would
    // announce mail the user has long since read.
    if (!settings.mailHistoryId) return await rebaseline(store, mail);

    const changed = await mail.listChangedThreads(settings.mailHistoryId);
    // The watermark fell outside Gmail's retention (a long gap, or the rare
    // short window). Start again from now: silence beats replaying a week of
    // mail into the chat.
    if (!changed.ok) {
      log("mail_history_expired", {});
      return await rebaseline(store, mail);
    }

    const hits = new Set(changed.threadIds);
    const notified: string[] = [];
    for (const thread of watched) {
      if (!hits.has(thread.threadId)) continue;
      // Queue BEFORE the watermark moves, so a reset in between announces a
      // reply twice rather than never.
      store.enqueuePendingMessage(
        thread.conversationId,
        input.composeText(thread.threadId),
      );
      notified.push(thread.threadId);
    }
    if (notified.length > 0) {
      store.markMailThreadsNotified(notified, new Date(now).toISOString());
    }
    // Unconditionally, hits or not: this is what stops a quiet thread's
    // watermark from ageing out of Gmail's history.
    store.updateSettings({ mailHistoryId: changed.historyId });
    log("mail_check_finished", {
      watched: watched.length,
      changed: changed.threadIds.length,
      notified: notified.length,
    });
    return { status: "checked", notified: notified.length };
  } catch (error) {
    // Not connected, or a revoked grant: stop polling rather than burn a call
    // an hour on a mailbox Zero cannot read. Reconnecting is a user action,
    // and their next message re-arms the pass.
    if (error instanceof GoogleNotConnectedError) return disarm("not_connected");
    if (error instanceof GoogleApiError && error.status === 401) {
      return disarm("not_connected");
    }
    throw error;
  }
};

const disarm = (
  reason: "no_threads" | "inactive" | "not_connected",
): MailWatchOutcome => {
  log("mail_watch_disarmed", { reason });
  return { status: "disarmed", reason };
};

const rebaseline = async (
  store: MailWatchStore,
  mail: Pick<MailApi, "getWatermark">,
): Promise<MailWatchOutcome> => {
  const { historyId } = await mail.getWatermark();
  store.updateSettings({ mailHistoryId: historyId });
  return { status: "rebaselined" };
};
