// track_email_thread / list_email_threads / untrack_email_thread for the
// interface agent. Watching a thread means Zero notices a reply on it within
// the hour and starts a turn in this chat, unprompted.
//
// Mail Zero sends is watched automatically (see tools/google.ts), so these
// tools are for threads the user points at: "tell me when the landlord
// answers". They see only the MailWatchBook port — no SQLite, no Gmail, no
// ScheduleDO, no chat id.

import { z } from "zod";
import { defineTool, type AgentToolSet } from "../agents/protocol";
import type { MailWatchBook, WatchedThread } from "../mail-watch/types";

export interface MailWatchToolDeps {
  // Absent in contexts without user storage (tests): the tools then report they
  // cannot watch rather than lying. They stay registered either way, so the
  // tool schema is byte-identical across users and turns (see docs/caching.md).
  mailWatch?: MailWatchBook;
  // Re-arm the user's hourly poll after a change. Fire-and-forget: a timer that
  // cannot be armed must not fail the user's turn.
  onWatchChanged?: () => void;
}

const NO_BOOK = "Can't watch email threads in this context.";

const render = (thread: WatchedThread) => ({
  threadId: thread.threadId,
  watchedSince: thread.createdAt,
  lastReplyAnnouncedAt: thread.lastNotifiedAt,
});

export const buildMailWatchTools = (deps: MailWatchToolDeps): AgentToolSet => {
  const { mailWatch, onWatchChanged } = deps;

  return {
    track_email_thread: defineTool({
      description:
        "Watch a Gmail thread for replies. Within the hour of a new message " +
        "arriving in it you will be started in this chat to tell the user and " +
        "act on it. Use it when the user is waiting on an answer to a thread " +
        "they did not send through you. `threadId` comes from a gmail_search " +
        "or gmail_thread result. Mail you send yourself is already watched, so " +
        "do not call this after gmail_send.",
      inputSchema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }) => {
        if (!mailWatch) return { error: NO_BOOK };
        const result = mailWatch.watch(threadId);
        if ("error" in result) return { error: result.error };
        onWatchChanged?.();
        return render(result.thread);
      },
    }),

    list_email_threads: defineTool({
      description:
        "List the Gmail threads being watched for replies in this chat. Use it " +
        "when the user asks what you are keeping an eye on, or to find a " +
        "threadId to stop watching. Call gmail_thread on a threadId if you need " +
        "to say what the thread is about.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!mailWatch) return { error: NO_BOOK };
        return { threads: mailWatch.list().map(render) };
      },
    }),

    untrack_email_thread: defineTool({
      description:
        "Stop watching a Gmail thread for replies. Use it when the matter is " +
        "settled, or when the user says they no longer care about it.",
      inputSchema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }) => {
        if (!mailWatch) return { error: NO_BOOK };
        if (!mailWatch.stop(threadId)) {
          return { error: `That thread isn't being watched: ${threadId}.` };
        }
        onWatchChanged?.();
        return { stopped: true, threadId };
      },
    }),
  };
};
