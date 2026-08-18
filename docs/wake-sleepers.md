# Waking sleeper users

A user who has not messaged Zero for a week gets **one** Telegram message in
their most recently active topic, re-engaging: it offers to help with one of
their latest unread emails, a topic from their knowledge, or (fallback) a plain
offer of help. If they stay silent they are not messaged again; if they return
and lapse another week, they can be woken again.

## The `wake` deadline

Ongoing wake-ups ride a `ScheduleDO` deadline reason `wake`, armed like
`reminder` and `mailwatch` (see `docs/schedules.md`):

- `UserDO.enqueueTurn` arms the user's single `wake` deadline at `now + 7d` on
  every accepted message, replacing by key (`WAKE_INACTIVE_MS`). It is armed
  **unconditionally** (every user, mail or not). While the user keeps messaging,
  the deadline keeps moving out and never fires.
- After a week of silence it fires once. `ScheduleDO` dispatches it to
  `UserDO.wakeSleeper()`.
- `wakeSleeper` does **not** re-arm the `wake` deadline. The user's next message
  re-arms it, so a user who lapses again later is woken again.

No LLM work runs on `ScheduleDO`; `wakeSleeper` only queues a pending message,
and the turn runs on `UserDO`'s own alarm behind whatever the user already
queued, like a schedule or a mail reply.

## Idempotency: the `wokeAt` marker

Two paths reach `wakeSleeper` (the deadline and the admin backfill), so
"one message per sleep episode" cannot rely on the deadline alone. A persisted
`wokeAt` timestamp on `user_settings` makes `wakeSleeper` self-dedupe. It sends
only when both hold:

- `now - lastActiveAt >= WAKE_INACTIVE_MS` (inactive at least a week), and
- `wokeAt` is null **or** `wokeAt <= lastActiveAt` (not already nudged since the
  user last spoke).

On send it sets `wokeAt = now`. No clearing is needed: after the user replies,
`enqueueTurn` moves `lastActiveAt` past `wokeAt`, re-enabling a future episode.
The guard lives in `do/wake.ts` (`runWake`), free of the Durable Object so it is
testable without one.

## The re-engagement note

`wakeSleeper` queues `WAKE_NOTE` (in `UserDO/turn-text.ts`) into the most
recently active topic (`getMostRecentConversation`: the conversation of the
newest message row of any kind, which is the topic to re-open — it may be a
topic Zero last posted into rather than where the human last typed). The note is
an instruction to the model: re-engage in one short message, offering help with
exactly one of, in order of preference: (a) one latest unread email
(`gmail_search("is:unread in:inbox")`, falling through if Google is not
connected), (b) a knowledge topic worth picking up, (c) a general offer of help.
It must not reveal that a timer triggered it.

## One-time backfill

The per-user deadline cannot reach a user who is already silent at deploy time
(nothing arms their `wake` deadline until they message again). `POST
/api/admin/wake-sleepers` (admin-gated) enumerates all users and calls the same
guarded `wakeSleeper()` on each, returning `202` and fanning out on `waitUntil`
with bounded concurrency. The `wokeAt` guard, not the enumeration, decides who is
messaged, so the backfill is idempotent and safe to re-run.
