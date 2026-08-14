# Schedules

A user can ask Zero to do something later: once ("remind me to call Ana at 6")
or on a routine ("every weekday at 8, send me my calendar and unread mail").
When the moment arrives Zero starts a turn on its own, with its full tools, and
messages the user in the thread the schedule was created in.

## One mechanism, two shapes

A **schedule** is a stored record with a `prompt` and a next due time. The
prompt is an instruction to Zero's future self, not user-facing copy. When the
record comes due, its prompt is queued as a pending message with the
`SCHEDULE_NOTE` prefix (`UserDO/turn-text.ts`) and the ordinary turn path
answers it.

A "reminder" is a schedule whose prompt is *remind the user to call Ana*; a
"task" is one whose prompt is *send today's calendar and unread mail*. There is
no second delivery path, no second agent, no separate send code: resume after a
reset, delivery claims, the typing indicator, learning and error reporting are
all inherited from a normal turn.

## Who owns what

`UserDO` owns the schedules. They live in that user's SQLite next to
conversations, and the agent tools that create them run in-process there.

`ScheduleDO` owns *when*. It gains one reason, `reminder`, holding a single
deadline per user, set to the **earliest** pending `nextDueAt`. Its dispatch
calls `UserDO.runDueSchedules()`, which enqueues the due prompts and returns.

That preserves the invariant ScheduleDO exists for: a Durable Object has exactly
one alarm, and no LLM work runs on ScheduleDO's. The turn a schedule books runs
on UserDO's alarm, behind whatever the user has already queued, never in front
of it.

`scheduleDeadline` replaces by key, so one reminder deadline per user is correct
**only because every caller passes the earliest** pending due time, read from
the store. `enqueueTurn` re-arms it too, so ordinary activity heals a deadline
that was lost or never armed.

## Representation

A schedule is `{ pattern, timezone }`:

- recurring: a five-field cron expression, e.g. `0 8 * * 1-5`
- one-shot: an ISO-8601 **local** datetime, e.g. `2026-08-05T18:00:00`

croner accepts both through one constructor, so there is one code path; a
one-shot is simply a pattern whose next run goes null once past.

`timezone` is snapshotted at creation from the user's setting. It is
deliberately **not** re-read from live settings: moving country must not
silently move every schedule the user already has. `set_timezone` plus
re-creating the schedule is the fix.

Cron's day-of-month/day-of-week field pair fires on *either*, which is a
standard footgun. Nothing in the prompt or the tool schema warns about it;
a schedule caught firing on the wrong days is cancelled and re-created.

## Why croner

There is no standalone "cron → DO alarm" package. The Cloudflare Agents SDK
does this internally with `cron-schedule`, which has no timezone support and
would drag in the whole `agents` framework.

[croner](https://github.com/hexagon/croner) is MIT, zero-dependency, ~27 KB, and
resolves IANA zones through `Intl`. It is used as a pure evaluator
(`new Cron(pattern, { timezone, paused: true }).nextRun(after)`), so it starts
no timer and touches nothing workerd lacks. DST follows its documented policy: a
spring-forward gap shifts the occurrence rather than dropping it, and a
fall-back overlap fires once. `cron-parser` was rejected (luxon, 208 KB), and
`cronstrue` as a dependency (748 KB of locales) — descriptions are rendered in
`schedules/recurrence.ts`.

croner is a one-maintainer project, so its import is confined to
`schedules/recurrence.ts`. Vendoring it is then a local change.

## Catch-up

`nextRun(now)` returns the next *future* occurrence, so downtime spanning
several occurrences collapses into a single fire. Firing forty backlogged "good
morning" messages is worse than having missed them. `planFiring` reports how
many were skipped in `schedule_fired`, bounded by `MAX_SKIP_SCAN` so a record
parked for a year does not walk 35,000 occurrences.

## At-least-once

`fireDueSchedules` enqueues the prompt **before** advancing `nextDueAt`, both
synchronously. If that ever tears, a schedule fires twice rather than never; for
a reminder the duplicate is the better failure.

## Limits

Every fire is a full agent turn, which is the cost that shapes the two limits:

- **Frequency floor:** two consecutive occurrences closer than 15 minutes are
  refused, as is a cron pattern with a seconds field. A model that misreads
  "every morning" cannot book an LLM call per minute.
- **Per-user cap:** 50 active schedules (`MAX_ACTIVE_SCHEDULES`).

## Modules

| file | what it is |
|---|---|
| `schedules/recurrence.ts` | when a pattern fires; validation; English descriptions. The only croner import. |
| `schedules/types.ts` | the `ScheduleBook` port the tools see. |
| `schedules/book.ts` | `ScheduleBook` over the store, bound to one conversation: ids, validation, cap, first due time. |
| `do/schedules.ts` | firing policy and the firing pass, free of the Durable Object. |
| `tools/schedules.ts` | `create_schedule` / `list_schedules` / `cancel_schedule`. |
| `store/types.ts` | `ScheduleRecordStore`, implemented by `DbStore` and `MemoryStore`. |
| `ScheduleDO/dispatch.ts` | which object owns each deadline reason. |

## Dispatch

A deadline is a flat record (`reason`, `dueAt`, optional `conversationId` and
`attempts`), and `reason` is the discriminant that decides what runs. The whole
set lives in one JSON blob under the `deadlines` key, keyed by
`${reason}:${conversationId ?? ""}`, which is why `reminder:` is a single slot
per user and why the caller must always pass the earliest due time.

The hourly poll for replies on watched email threads is another reason,
`mailwatch`, on the same mechanism (see `docs/mail-watch.md`).

`ScheduleDO/dispatch.ts` maps each reason to one RPC, as a
`Record<ScheduleReason, Handler>`. It is total on purpose: adding a reason
without a handler is a compile error, rather than falling through to whichever
branch happened to be last, which would fail as silence. The alarm itself picks
a handler and calls it; it holds no job logic.

`reason` is a persisted wire format, so those strings sit in live Durable Object
storage. A reason that was renamed or retired comes back with no handler; such an
entry is dropped with a `schedule_unknown_reason` log rather than retried,
because no amount of backoff will produce a handler for it.

The tools are registered unconditionally, like the file tools, so the tool
schema stays byte-identical across users and turns (see `caching.md`). They go
to the interface agent only: the research and writer agents cannot message the
user, so they must not be able to book a turn that does.

There is no `update_schedule`. Cancel plus create covers it without
partial-patch semantics.

## Logs

Shape and counts, never user content: `schedule_created`, `schedule_rejected`
(`pattern` | `timezone` | `cap`), `schedule_fired` (lateness, skipped, whether
it recurs), `schedule_cancelled`, `schedule_retired`, `schedules_finished`.
