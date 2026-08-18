# Plan: wake up sleeper users

## Goal

A user who has not messaged Zero for one week gets **one** Telegram message in
their most recent topic, where Zero re-engages: it offers to help with one of
their latest unread emails, or with a topic from their knowledge, or (fallback) a
general offer of help. If they stay silent they are not messaged again; if they
return and lapse another week, they can be woken again. Users who are **already**
inactive at deploy time are reached once via a one-time backfill.

## Key decision: per-user deadline for ongoing lapses, plus a one-time backfill

The obvious approach (a recurring Cloudflare cron that enumerates all Clerk users
and checks each `UserDO`) is rejected for the **ongoing** behavior: it fans out
one RPC per user per run, needs Clerk pagination, and duplicates work the
scheduling architecture already does per user.

Instead, ongoing wake-ups ride a new `ScheduleDO` deadline reason `wake`, armed
exactly like `reminder` and `mailwatch`:

- On every accepted user message (`UserDO.enqueueTurn`), arm the user's single
  `wake` deadline at `now + 7d`, replacing by key. While the user keeps
  messaging, the deadline keeps moving out and never fires.
- After 7 days of silence it fires once. `ScheduleDO` dispatches it to
  `UserDO.wakeSleeper()`, which posts the wake message.
- `wakeSleeper` does **not** re-arm the `wake` deadline. The user's next message
  re-arms it (`now + 7d`), so a user who lapses again later is woken again.

This mirrors `mailwatch` and `reminder` (one slot per user, replaced by key,
healed by the next message), so it inherits their tested semantics and adds no
new moving parts to the alarm model. No LLM work runs on `ScheduleDO`; the wake
turn runs on `UserDO`'s own alarm behind whatever the user already queued, like a
schedule or a mail reply.

The per-user deadline cannot reach a user who is **already** silent at deploy
time (nothing arms their `wake` deadline until they message again). To wake those
users once, add a one-time, admin-triggered **backfill** that enumerates all
users and calls the same guarded `wakeSleeper()` on each. The guard, not the
enumeration, decides who is actually messaged.

## Idempotency: the `wokeAt` marker

Two trigger paths (the deadline and the backfill) reach `wakeSleeper`, so
"one message per sleep episode" cannot rely on the deadline alone (a backfill has
no deadline, and re-running it would re-nudge). A persisted marker makes
`wakeSleeper` self-dedupe regardless of trigger:

- Add a `wokeAt` timestamp to `user_settings`.
- `wakeSleeper` sends only when both hold:
  - `now - lastActiveAt >= WAKE_INACTIVE_MS` (inactive at least a week), and
  - `wokeAt` is null **or** `wokeAt <= lastActiveAt` (not already nudged since the
    user last spoke).
- On send, set `wokeAt = now`.

No clearing is needed: after the user replies, `enqueueTurn` sets
`lastActiveAt > wokeAt`, which naturally re-enables a future episode. Both the
deadline path and the backfill call the same guarded `wakeSleeper`, so both are
idempotent; a repeated backfill is a no-op for an already-nudged user.

## What to change

**1. New deadline reason `wake`** (`src/do/schedule.ts`)
- Add `"wake"` to `ScheduleReason`.
- Add `requestWakeAt(clerkUserId, dueAt)` to the `ScheduleTarget` interface.
- Add `requestWakeSafely(schedule, clerkUserId, dueAt)` best-effort helper, same
  shape as `requestMailWatchSafely` (a timer that cannot be armed must never fail
  the turn).
- Add `WAKE_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000`.

**2. ScheduleDO RPC** (`src/ScheduleDO/index.ts`)
- Add `requestWakeAt(clerkUserId, dueAt)` calling
  `scheduleDeadline(storage, { reason: "wake", dueAt })`, mirroring
  `requestMailWatchAt`.

**3. Dispatch** (`src/ScheduleDO/dispatch.ts`)
- Add `wake: ({ env, clerkUserId }) => getUserDO(env, clerkUserId).wakeSleeper()`.
  The `DISPATCH` record is total, so this is required to compile.

**4. Arm on activity** (`src/UserDO/index.ts`, `enqueueTurn`)
- After the existing `requestReminderSafely` / mailwatch arming, call
  `requestWakeSafely(getScheduleDO(...), clerkUserId, Date.now() + WAKE_INACTIVE_MS)`.
  Arm it **unconditionally** — outside the `if (listMailThreads().length > 0)` that
  gates the mail arm — since every user, mail or not, should be woken. This is the
  only arm point; ordinary activity keeps pushing it out and heals a lost deadline.

**5. `UserDO.wakeSleeper()`** (`src/UserDO/index.ts`)
- Read `clerkUserId`; return if absent.
- Read settings. Apply the episode guard (inactive >= `WAKE_INACTIVE_MS` **and**
  `wokeAt` null-or-`<= lastActiveAt`); return without messaging otherwise. This
  covers the race where a message landed between arming and firing. `lastActiveAt`
  is `string | null`; a null value means the user never messaged, so the guard
  treats null as "not inactive-with-history" and skips (the no-conversation check
  below also catches this).
- Find the most recent conversation via `getMostRecentConversation()`; if none,
  return (a user who never messaged has nothing to wake into).
- Set `wokeAt = now`. Enqueue a pending message with the `WAKE_NOTE` prefix into
  that conversation, then arm the `UserDO` alarm (`setAlarm(Date.now())` when none
  is set), exactly as `checkTrackedMail` does on a hit.
- Do **not** re-arm the `wake` deadline.
- Log `wake_fired`, and `wake_skipped` with reason (`active` | `already_woken` |
  `no_conversation`); counts and shape only, never content.

**6. Most-recent-conversation query** (`src/store/types.ts`, `db.ts`,
`memory.ts`, contract test)
- Add `getMostRecentConversation(): Thread | null` to `ConversationStore`: the
  conversation of the newest message row of any kind (`messages` ordered by
  `id desc`), or `null` when the user has no messages. This is the most recently
  active topic, not necessarily where the human last typed: injected notes
  (schedule / mailwatch / wake) drain as `role:"user"` rows, so a role filter
  would not isolate genuine user speech. Newest-row of any kind is the simple,
  correct choice for "topic to re-open". `db.ts` already uses `orderBy: desc("id")`
  elsewhere; `memory.ts` mirrors it; add a case to `store/store-contract.test.ts`
  so both adapters agree.

**7. `wokeAt` settings column** (`src/UserDO/db/migrations/0035_*.sql`,
`db/schema.ts`, `store/types.ts`, `db.ts`, `memory.ts`, contract test)
- New migration adds a nullable `wokeAt` text column to `user_settings`.
- Add `wokeAt: string | null` to `UserSettings`, and `wokeAt?: string` to the
  `updateSettings` patch. Mirror in both store adapters; extend the settings case
  in `store/store-contract.test.ts`.

**8. `WAKE_NOTE`** (`src/UserDO/turn-text.ts`)
- A note in the same family as `SCHEDULE_NOTE` / `MAIL_NOTE`: an instruction to
  the model, not user-facing copy. It states that nobody asked anything right now;
  the user has been quiet about a week; re-engage warmly in **one short message**;
  offer help with exactly one of, in order of preference: (a) one of their latest
  unread emails — try `gmail_search("is:unread in:inbox")`, and if it errors
  because Google is not connected, fall through; (b) a topic in the user's
  knowledge worth picking up (`list_topics` / a recent topic); (c) a plain general
  offer of help. Pick the single most relevant; send no more than one message; do
  not mention that a timer or schedule triggered you; if nothing fits, a short
  friendly check-in is fine.
- Note: `gmail_search` is always registered on the interface agent
  (`src/agents/interface.ts` builds Google tools unconditionally) and guards on
  connection at call time, so the note must use try-then-fallback rather than
  assuming the tool is absent when Google is not connected.

**9. Admin backfill endpoint** (`src/routes/admin.ts`)
- `POST /api/admin/wake-sleepers`, gated by the existing `/api/admin/*` admin
  check. Define it with `createRoute` + `router.openapi` (the file's OpenAPI
  style, not a bare `router.post`), with a `202` response schema. Returns `202`
  immediately and fans out on `c.executionCtx.waitUntil`:
  enumerate `listClerkUsers`, and for each call `getUserDO(...).wakeSleeper()`
  with bounded concurrency (batches). The guard inside `wakeSleeper` decides who
  is actually messaged; active or already-woken users are no-ops. Log
  `wake_backfill_finished` (counts only). One-time, admin-controlled, so the
  fan-out cost is a controlled one-off.

## Tests to add or update

- `src/do/schedule.test.ts` (or nearest): `requestWakeSafely` swallows errors and
  logs; `wake` participates in `setDeadline` / `earliestDueAt` like other reasons.
- `src/ScheduleDO/dispatch.test.ts`: `dispatchFor("wake")` routes to
  `UserDO.wakeSleeper`; the record stays total.
- New `wakeSleeper` unit test against `MemoryStore`: (a) inactive, not-yet-woken
  user with a conversation enqueues one pending message carrying `WAKE_NOTE`, sets
  `wokeAt`, and arms the alarm; (b) active user (within window) does nothing; (c)
  already-woken user (`wokeAt > lastActiveAt`) does nothing — a repeated backfill
  is a no-op; (d) user with no conversation does nothing; (e) it does not re-arm
  the wake deadline.
- `src/store/store-contract.test.ts`: `getMostRecentConversation` returns the
  newest message's conversation and `null` on an empty store; `wokeAt` round-trips
  through `updateSettings` / `getSettings`. Identical for both adapters.
- `src/UserDO/turn-text.test.ts`: `WAKE_NOTE` / compose helper ordering, matching
  the existing note tests.
- Arming on `enqueueTurn`: extend the existing enqueue test to assert
  `requestWakeAt` is called at `now + 7d` (alongside the reminder/mailwatch
  assertions).
- `src/routes/admin.test.ts`: the backfill endpoint is admin-gated (403 for
  non-admin), enumerates users, and invokes `wakeSleeper` per user; the guard, not
  the endpoint, decides who is messaged.

Follow behavior-driven TDD: assert the observable outcome (a message queued, an
alarm armed, a deadline dispatched, `wokeAt` set), not internals.

## Docs to add or update

- New `docs/wake-sleepers.md` (short) describing the `wake` reason: armed on every
  message at `now + 7d`, fires once per sleep episode, not re-armed, healed by the
  next message; the `wokeAt` idempotency marker shared by the deadline and backfill
  paths; the one-time admin backfill for already-inactive users; and the WAKE_NOTE
  re-engagement policy.
- `docs/schedules.md` deadline/dispatch tables and the `docs/topics.md`
  "Execution" note both enumerate the reasons; add `wake` so the
  `Record<ScheduleReason, Handler>` totality note stays accurate.

## Changelog

Add to `apps/agent-api/CHANGELOG.md` (this file ships in-product), user-facing,
most recent first:

`- YYYY-MM-DD: If you go quiet for about a week, Zero now checks in once — offering to pick up an unread email, a topic you were working on, or just to help.`

## Skills to use

- `tdd` — for the deadline reason, `wakeSleeper`, the store query, and the backfill
  endpoint; RED-GREEN-REFACTOR per increment.
- `testing` — behavior-focused assertions and the store-contract cases.
- `changelog` — before editing `apps/agent-api/CHANGELOG.md`.
- `git-commit` — when committing.
- `development-guidelines` — throughout, for TS-strict and functional preferences.

## Acceptance criteria

1. A user silent for 7 days receives exactly one Telegram message in their most
   recently active topic.
2. The message re-engages and offers help with one of: a latest unread email (if
   Google connected), a knowledge topic, or a general offer — the model chooses
   one and sends a single short message.
3. A user who keeps messaging is never woken (deadline keeps moving out).
4. A woken user who stays silent is not messaged again during that sleep episode,
   through either the deadline or a repeated backfill (`wokeAt` guard).
5. A user who returns, is active, then lapses another week is woken again.
6. The message does not reveal that a timer/schedule/backfill triggered it.
7. A user with no prior conversation is never woken.
8. Ongoing wake-ups add no fan-out cost: no recurring cron, no Clerk enumeration;
   work stays per-user on the existing deadline mechanism.
9. Already-inactive users at deploy time are reached once via the admin backfill,
   which is idempotent (safe to re-run).
10. `wakeSleeper` runs no LLM work on `ScheduleDO`; the turn runs on `UserDO`'s
    alarm behind queued user messages.

## Risks and mitigations

- **Race (message lands between arm and fire):** the episode guard in
  `wakeSleeper` skips the wake; the incoming message already re-armed the deadline
  and moved `lastActiveAt` past `wokeAt`.
- **Repeated backfill / double-hit:** the `wokeAt` guard makes a second call a
  no-op for an already-nudged inactive user.
- **At-least-once alarm double-fire:** enqueue-before-alarm plus the
  delivery-claim path (`deliveries`) means a duplicate fire re-runs the same turn
  and sends at most once, same guarantee as mail watch.
- **Backfill fan-out cost/time:** the endpoint returns `202` and fans out on
  `waitUntil` with bounded concurrency; admin-gated and one-time.
- **Wrong-topic delivery:** "most recent conversation" is the newest message row
  of any kind — the most recently active topic, which is the correct topic to
  re-open. It may be a topic Zero last posted into (a schedule or mail reply)
  rather than the exact one the human last typed in; that is still the live
  thread and the right place to re-engage.
