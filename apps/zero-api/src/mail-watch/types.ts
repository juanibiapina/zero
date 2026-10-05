// The watched-thread port the agent tools are written against. No SQLite, no
// Gmail, no Durable Object, no chat id: a tool can watch, list and stop, and
// nothing else.

export interface WatchedThread {
  threadId: string;
  createdAt: string;
  // When Zero last announced a reply on this thread, or null if never.
  lastNotifiedAt: string | null;
}

// `cap` is the per-user ceiling on watched threads.
export type WatchRejection = "cap";

export type WatchResult =
  | { thread: WatchedThread }
  | { error: string; reason: WatchRejection };

export interface MailWatchBook {
  watch(threadId: string): WatchResult;
  list(): WatchedThread[];
  // False when this thread was not being watched.
  stop(threadId: string): boolean;
}
