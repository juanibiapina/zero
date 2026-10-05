// The MailWatchBook adapter over the store, bound to one conversation: a reply
// is announced in the chat the thread was watched from.
//
// Everything a watch must get right lives here (the per-user cap, the binding
// to this conversation), so the tools stay a thin translation to the model's
// wire format.

import { MAX_WATCHED_THREADS } from "../do/mail-watch";
import { log } from "../log";
import type { MailThreadRecord, MailThreadStore } from "../store/types";
import type { MailWatchBook, WatchResult, WatchedThread } from "./types";

export interface MailWatchBookDeps {
  store: MailThreadStore;
  conversationId: string;
}

const toWatched = (record: MailThreadRecord): WatchedThread => ({
  threadId: record.threadId,
  createdAt: record.createdAt,
  lastNotifiedAt: record.lastNotifiedAt,
});

export const createMailWatchBook = (
  deps: MailWatchBookDeps,
): MailWatchBook => {
  const { store, conversationId } = deps;

  return {
    watch(threadId: string): WatchResult {
      const active = store.listMailThreads();
      const already = active.some((t) => t.threadId === threadId);
      // The cap counts every conversation, since every watched thread costs
      // the same one mailbox poll and can book a turn. Re-watching one that is
      // already counted is always allowed.
      if (!already && active.length >= MAX_WATCHED_THREADS) {
        log("mail_thread_rejected", { reason: "cap" });
        return {
          error: `You're already watching ${MAX_WATCHED_THREADS} email threads, which is the limit. Stop watching one first.`,
          reason: "cap",
        };
      }
      const record = store.trackMailThread({ threadId, conversationId });
      log("mail_thread_tracked", { already });
      return { thread: toWatched(record) };
    },

    list(): WatchedThread[] {
      return store.listMailThreads(conversationId).map(toWatched);
    },

    stop(threadId: string): boolean {
      const stopped = store.untrackMailThread(threadId);
      if (stopped) log("mail_thread_untracked", {});
      return stopped;
    },
  };
};
