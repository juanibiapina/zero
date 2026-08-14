# Watching email threads

Zero notices when a reply lands on an email thread it cares about, and starts a
turn on its own to tell the user and carry on with whatever the thread was for.

A thread is watched automatically when Zero sends mail (that is the whole reason
the mail was sent), or explicitly with `track_email_thread`. Every watched
thread is bound to the conversation it was watched from, and speaks there.

## Who owns what

`UserDO` owns the watched threads (`mail_threads` in that user's SQLite) and the
poll itself (`checkTrackedMail`). `ScheduleDO` owns *when*: one deadline per
user, reason `mailwatch`, held an hour out. Nothing new: it is the same
mechanism as reminders (see `docs/schedules.md`), and no LLM work runs on
`ScheduleDO`'s alarm. A reply queues an ordinary pending message and the turn
happens on UserDO's own alarm, behind whatever the user already queued.

`do/mail-watch.ts` holds the policy, free of the Durable Object, so the whole
pass is testable without one.

## One watermark, not one per thread

Gmail's `historyId` is a **mailbox** sequence number ("The ID of the mailbox's
current history record"), not a property of a thread, and one `history.list`
call covers every watched thread at once. So the watermark is a single value on
`user_settings.mailHistoryId`; `mail_threads` deliberately has no history column.

Every successful pass advances that watermark **whether or not anything
matched**. That is what keeps a thread that has been quiet for months watchable:
its freshness comes from the mailbox being polled, not from the thread receiving
mail.

## The pass

Per active watching user, once an hour:

1. Nothing watched, or no message from the user in 7 days: **do not re-arm**.
   Their next message arms it again (`enqueueTurn`), which is also how a lost
   deadline heals.
2. One `history.list` from the watermark, filtered server-side to
   `historyTypes=messageAdded` and `labelId=INBOX`. The user's own replies and
   Zero's own sends are `SENT`/`DRAFT`, never `INBOX`, so they never come back
   and no client-side label logic exists.
3. Intersect the returned thread ids with the watched rows; queue one turn per
   hit, in that thread's own conversation.
4. Advance the watermark, re-arm for an hour's time.

Cost per active watching user per hour: one DO alarm, one Clerk token mint, one
Gmail call, and **zero** message fetches, regardless of how many threads are
watched. A user with nothing watched, or who has been away a week, costs
nothing.

The queue happens **before** the watermark moves, both synchronously, so a reset
in between announces a reply twice rather than never.

## Only the thread id travels

A history record's messages "will typically only have `id` and `threadId` fields
populated" (Gmail docs), so sender, subject and snippet are not available
without a fetch per message. The notification therefore carries the thread id
alone and `MAIL_NOTE` tells the model to open it with `gmail_thread`. Nothing is
stored about *why* a thread is watched either: the chat and the thread already
hold that, and a third copy would go stale.

## Expiry

Gmail keeps history records "typically at least one week and often longer.
However, the time period for which records are available may be significantly
less", and in rare cases a `historyId` is valid for only a few hours. An
out-of-range watermark is answered with `404`, which the adapter reports as
`{ ok: false, reason: "expired" }` — an expected outcome, not an error.

Recovery is to re-baseline to the mailbox's current `historyId` and announce
**nothing** for the gap. Silence beats replaying a week of mail into the chat;
the user's next question about the thread reads it live anyway. Hourly polling
keeps the watermark under an hour old, so this normally only happens to a user
who was away past the 7-day cutoff and came back.

## Limits

- **50 watched threads per user** (`MAX_WATCHED_THREADS`). Each one is a
  candidate turn. Hitting the cap never fails a send: the mail is already gone
  and cannot be unsent, so the watch is skipped and logged.
- A watched thread dies with its conversation: resetting a chat drops what was
  being watched there, because the notification has nowhere else to land.
- Google not connected, or a revoked grant (401): the pass stops re-arming
  instead of burning a call an hour on a mailbox it cannot read.

## Scopes

None added. `gmail.modify` already covers `users.history.list` and
`users.getProfile`, so this shipped without a re-consent.

## Logs

Shape and counts, never content: `mail_thread_tracked`, `mail_thread_untracked`,
`mail_thread_rejected` (`cap`), `mail_check_finished` (watched, changed,
notified), `mail_history_expired`, `mail_history_pages_capped`,
`mail_watch_disarmed` (`no_threads` | `inactive` | `not_connected`).
