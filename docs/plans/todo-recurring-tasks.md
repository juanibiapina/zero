# Recurring tasks: shared recurrence module and product integration

## Bottom line

Build recurring tasks as one end-to-end capability over a new private workspace
package, `@zeroapps/recurrence` (`packages/recurrence`). The package owns natural-
language schedule extraction, one-time date parsing through Chrono, normalized
recurrence rules, human-readable summaries, validation, and occurrence advancement
through `rrule-temporal`. It exposes one deep interface to Hermes, web, and
Cloudflare callers; no caller sees Chrono, RRULE strings, Temporal objects, or
provider-specific behavior.

A recurring Task remains one row. It gains a persisted normalized `recurrence` and
a separate `recurrenceDate`, the date of the current occurrence on the recurrence
series. `showUpDate` remains the date controlling Home/Upcoming and can be changed
for a one-off postpone without moving the series. Completion atomically advances
the row; scheduled recurrence (`every`) catches up one occurrence at a time and
may produce another overdue date, while completion recurrence (`every!`) re-anchors
from the completion date. No scheduled occurrence is skipped.

The first release covers complete **English Todoist-style grammar at date
precision**. Time, duration, hourly recurrence, and other languages remain ordinary
title text. The parser uses only an explicit caller-supplied local date and week
start; it never reads the host clock or timezone. When behavior is unclear,
consult Todoist's current documented behavior first. Record every deliberate
deviation in package tests and documentation.

The change ships in package-first phases: package contract and tests, server/data
model, offline client data layer, then web/mobile UI. The user-facing capability is
complete only after both surfaces and the physical Pixel 7 pass.

## Context

Task is the todo app's single item type. `showUpDate` is a nullable local
`YYYY-MM-DD`; Home and Upcoming derive visibility client-side. The take-on star has
been retired, so the date is the sole commitment gate. Completing an ordinary task
sets `completedAt`, removes the row from the open collection, and offers one global
Undo snackbar backed by the collection's `revive` verb.

Recurring tasks use the already-decided single-row model. Completing one normally
moves the same row to its next occurrence rather than spawning a Task. A bounded
series completes normally after its inclusive `until` date. There is no completion-
history entity and no occurrence count in v1.

Research sources cloned locally:

- `/home/juan/workspace/tasks/tasks`: shipping todo semantics and exact clamp,
  anchor, bounded-series, and lifecycle fixtures under
  `app/src/test/java/com/todoroo/astrid/repeats/`.
- `/home/juan/workspace/ggaabe/rrule-temporal`: Temporal/RRULE implementation and
  RFC/edge-case tests under `tests/`.

## Locked product decisions

### Recurrence semantics

- `every` means **scheduled anchor**. Advance from the current occurrence's
  `recurrenceDate`, including when it is overdue. The next date can also be
  overdue, so rent due monthly never loses a month and can be completed several
  times in one day to catch up.
- `every!` and `after N units` mean **completion anchor**. Advance from the local
  completion date, so `every! 3 days` completed on September 16 next appears on
  September 19.
- This intentionally improves on Todoist's documented overdue behavior. Todoist
  skips to a future occurrence and can collapse `every` and `every!` when overdue;
  this product preserves their distinction and never skips scheduled obligations.
- One-off postpone changes only `showUpDate`. It never changes `recurrenceDate`,
  `origin`, or the recurrence pattern. If a March 2 monthly occurrence is
  postponed to April 3 and completed there, the next scheduled occurrence is
  April 2 and appears overdue.
- Invalid calendar days clamp backward rather than disappear. A rule on the 31st
  produces February 28/29 and returns to the 31st when available. This matches
  tasks.org's explicit “you can't skip a bill because February 30 does not exist”
  behavior and corresponds to RFC 7529 `SKIP=BACKWARD`.
- `until` is inclusive and package-owned. If the next candidate exceeds it,
  advancement reports `finished` and the Task completes normally.
- Occurrence count is out. Todoist's documented finite grammar uses an end date or
  duration (`for 3 weeks`, normalized to `until`), not an occurrence count.
- Workday means Monday through Friday only, matching Todoist documentation; public
  holidays do not alter workday calculations.

### Parsing and quick-add semantics

- The package parses a **complete task title**, owns extraction, and returns the
  cleaned title plus consumed UTF-16 ranges (start inclusive, end exclusive).
- It tries recurrence grammar first, then its internal date-only Chrono adapter.
  Recurrence wins when candidates overlap.
- Among disjoint candidates, the rightmost maximal schedule wins. Within one
  grammar, choose the longest valid span.
- Parse live while the user types. Highlight the consumed range. Tapping the
  highlight suppresses that recognition for the current draft; submit applies only
  the visible recognition.
- The package recognizes only supported date-level text. Other words remain title
  text without errors or warnings:
  - `Call Ana tomorrow at 3pm` consumes `tomorrow`, schedules tomorrow, and leaves
    `Call Ana at 3pm`.
  - `Workout every Monday at 3pm` consumes `every Monday`, creates the recurrence,
    and leaves `Workout at 3pm`.
  - `Take medicine every 12 hours` finds no supported schedule and leaves the
    title unchanged.
- Parsing requires `{ today, weekStartsOn }`. `today` is the caller's local ISO
  date. The package never reads `new Date()` for “now,” host timezone, or locale.
- English only in v1. Time, duration, sub-daily frequency, and other languages are
  outside the parser grammar until Task can represent them.
- The recurrence grammar captures all documented English Todoist forms that have
  date-only meaning, including aliases and abbreviations, starts/ends, intervals,
  weekdays/weekends/workdays, multiple selectors, ordinal weekdays/workdays,
  monthly and annual dates, quarters, fixed holidays, `every`, and `every!`.

### Persistence and lifecycle

- Recurrence is a value object on Task, not a new entity.
- Store it as versioned normalized JSON in the Task row. Do not expose or persist
  RRULE text or Temporal values.
- Add `recurrenceDate` as the current occurrence's pattern date. For a recurring
  task, it is non-null even when `showUpDate` differs because of postpone.
- Completing a recurring task does not set `completedAt` while another occurrence
  exists. It updates `recurrenceDate` and `showUpDate` to the next date.
- No `task_completions` table in v1.
- Reuse the one global Undo snackbar. Undo restores the pre-completion Task
  snapshot only when the stored row still matches the expected post-completion
  occurrence. A second completion replaces the first Undo.
- Replayed completion must never advance twice. The request's expected
  `scheduledOn` (`recurrenceDate`) is its exactly-once guard.

## Package interface

Create `packages/recurrence/package.json` as `@zeroapps/recurrence`, private at
first, ESM, MIT licensed, and following the repo's TypeScript, ESLint, and Vitest
conventions. Its public interface must not leak Chrono, RRULE, Temporal, Zod, or app
Task types.

Start with source exports like other private workspace packages. npm publishing,
build artifacts, provenance, and a release workflow are separate work; the package
name, interface, README, tests, and dependency isolation must be suitable for that
later change.

### Public types

Use an opaque/branded TypeScript `PlainDate` whose runtime representation is
`YYYY-MM-DD`. Validate every value entering from untyped JSON.

```ts
type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
type WeekStart = "MO" | "SU"

type Recurrence = {
  version: 1
  origin: PlainDate
  anchor: "scheduled" | "completed"
  weekStartsOn: WeekStart
  until?: PlainDate
  pattern: Pattern
}

type Pattern =
  | { unit: "day"; interval: number }
  | { unit: "workday"; interval: number }
  | { unit: "week"; interval: number; weekdays: Weekday[] }
  | { unit: "month"; interval: number; on: MonthSelector[] }
  | { unit: "year"; interval: number; on: YearSelector[] }

type MonthSelector =
  | { kind: "day"; day: number | "last" }
  | { kind: "weekday"; ordinal: number | "last"; weekday: Weekday }
  | { kind: "workday"; ordinal: number | "last" }

type YearSelector =
  | { kind: "date"; month: number; day: number }
  | { kind: "weekday"; month: number; ordinal: number | "last"; weekday: Weekday }
  | { kind: "workday"; month: number; ordinal: number | "last" }

type Schedule =
  | { kind: "once"; date: PlainDate }
  | { kind: "recurring"; recurrence: Recurrence }

type ParseScheduleResult =
  | {
      kind: "scheduled"
      remainingText: string
      schedule: Schedule
      consumed: Array<{ start: number; end: number; text: string }>
    }
  | { kind: "none" }

type AdvanceResult =
  | { kind: "next"; scheduledOn: PlainDate }
  | { kind: "finished" }
```

Validate selector ranges, non-empty selector arrays, interval `>= 1`, sorted and
deduplicated selectors, `origin <= until`, and allowed selector/frequency
combinations. Normalize equivalent input so structurally equal recurrences serialize
the same way.

### Public operations

```ts
parseSchedule(
  text: string,
  context: { today: PlainDate; weekStartsOn: WeekStart },
): ParseScheduleResult

advance(
  recurrence: Recurrence,
  event: { scheduledOn: PlainDate; completedOn: PlainDate },
): AdvanceResult

toText(recurrence: Recurrence): string

validateRecurrence(value: unknown):
  | { ok: true; value: Recurrence }
  | { ok: false; errors: ValidationError[] }
```

`advance()` owns anchor semantics:

- scheduled: find the next origin-aligned pattern occurrence strictly after
  `scheduledOn`;
- completed: re-root recurrence calculation at `completedOn` and find the first
  valid occurrence after it;
- return `finished` when the candidate exceeds inclusive `until`.

Do not export a competing low-level `next()` in v1. Add future-occurrence
enumeration only when the product implements a preview. `origin` makes that future
addition deterministic; completion-anchored future dates remain unknowable until
completion.

`toText()` emits one canonical English summary; original input wording remains only
in `ParseScheduleResult.consumed` during the draft.

### Internal adapters

- **Chrono adapter:** import only `chrono-node/en`. Build a date-only English Chrono
  configuration by retaining date parsers/refiners and excluding time-only parsing
  and date/time merge behavior. Contract tests must prove exact consumed spans so
  `tomorrow at 3pm` consumes only `tomorrow`.
- **RRULE adapter:** map normalized patterns to `rrule-temporal`, use Gregorian
  `SKIP=BACKWARD` where invalid dates need clamping, and convert Temporal results
  back to `PlainDate` before they leave the implementation. Handle workday cadence
  and selectors in the adapter because they are product semantics rather than
  standard RRULE fields.
- No internal adapter type appears in the external interface.

## Server and Task model

### Migration and storage

Add migration `0055` (next after current `0054`) with two nullable columns:

- `recurrence TEXT` — versioned canonical JSON;
- `recurrenceDate TEXT` — current occurrence's pattern date.

Existing rows remain null/non-recurring. Add both columns to the do-orm schema.
`DbTaskStore` serializes on write and validates/deserializes on read through
`@zeroapps/recurrence`; malformed stored JSON is reported and fails explicitly
rather than silently changing schedule behavior.

Extend the shared and server Task types:

```ts
recurrence: Recurrence | null
recurrenceDate: PlainDate | null
```

Enforce these invariants at every write seam:

- both null for ordinary tasks;
- both non-null for recurring tasks;
- initial `recurrenceDate == recurrence.origin`;
- initial `showUpDate == recurrence.origin`;
- changing only `showUpDate` never changes recurrence state.

### Domain operations and HTTP

Extend add to accept an optional recurrence. The server validates it and derives
both dates from `origin`; it does not trust contradictory client dates.

Add one atomic replace/clear operation for recurrence rather than smearing its
three-field invariant across generic PATCH fields:

- setting a recurrence validates it and resets `recurrenceDate` and `showUpDate`
  to its `origin`;
- clearing recurrence sets `recurrence` and `recurrenceDate` null while preserving
  the current `showUpDate` as an ordinary task date.

Widen completion to receive the client-local event date and expected occurrence:

```json
{
  "scheduledOn": "2026-09-01",
  "completedOn": "2026-09-16"
}
```

Server behavior:

1. Ordinary task: complete as today.
2. Recurring task whose stored cursor equals `scheduledOn`: call `advance()` once.
3. `next`: update `recurrenceDate` and `showUpDate` atomically, leave
   `completedAt` null.
4. `finished`: set `completedAt` normally.
5. Cursor already differs: treat the command as a replay/stale completion, return
   current state, and never advance again.

Add a distinct **Complete forever** action for an open recurring task. It bypasses
advancement, sets `completedAt`, and uses the ordinary completion Undo path.

Add recurring-completion Undo with the original event plus
`showUpDateBefore`. The server recomputes the expected post-state and restores the
pre-state only when the stored task still matches it; duplicate Undo is a no-op,
and stale Undo never rolls back a later completion. Exhausted-series Undo reopens
and revives the row through the existing revive semantics.

Log ordinary completion, occurrence advancement, exhausted-series completion,
Complete forever, and recurring Undo as distinct structured events.

## Offline collection integration

Add `@zeroapps/recurrence` as a direct dependency wherever its operations are used;
do not reimplement advancement in agent-core or either app.

Update the Task collection:

- add recurrence fields to optimistic drafts and REST contracts;
- change `complete(id)` to receive the caller's `completedOn` local date;
- for recurring rows, call `advance()` optimistically and update the same row;
- for finished/ordinary rows, retain completed-row eviction;
- create an explicit recurring-completion verb matched by `recurrenceDate` before
  the existing `showUpDate` reschedule matcher;
- carry the pre-completion Task snapshot and completion event into Undo;
- keep outbox payloads stable and idempotent across restart/replay;
- reconcile the authoritative server row after every write.

Test both in-memory and persisted paths. The prior Undo bug proved in-memory tests
are insufficient: persisted reconciliation can evict or replace rows in ways an
in-memory collection does not.

## User interface

### Quick add and natural-language recognition

Apply parsing only in Task add modes, not Project naming modes.

For web and mobile Task quick-add:

- run `parseSchedule` synchronously from the current draft and explicit local
  `today`/week-start context;
- highlight consumed ranges while leaving the text editable;
- tapping a highlighted range suppresses recognition for the current draft;
- show the parsed one-time date or canonical repeat summary through the existing
  date-chip area;
- on submit, persist `remainingText` and the parsed schedule;
- manual date/repeat picker changes replace the current parsed schedule and
  suppress the old inline recognition so two schedule sources never compete;
- unrecognized time words remain in the submitted title.

Web can implement marked input with a mirrored text layer. Mobile must first prove
a pure-JS mirrored `Text` + transparent `TextInput` implementation on the Pixel 7,
including wrapping, selection, IME composition, accessibility, and tap-to-
unrecognize. Do not silently substitute a chip-only UX. If the pure-JS editor
cannot pass, stop and re-plan a native rich-text dependency rather than shipping a
fragile overlay; a native dependency requires a new development build.

### Scheduler and recurrence editing

Extend the existing schedule sheet/popover rather than create a second scheduling
surface:

- natural-language schedule field using the same parser;
- Repeat presets and a custom editor backed directly by the normalized selector
  tree;
- canonical summary from `toText()`;
- edit recurrence, including origin and inclusive end date;
- Stop repeating: clear recurrence/cursor and keep the current `showUpDate`;
- Complete forever in the recurring task's overflow/actions;
- choosing a one-off date on a recurring task changes only `showUpDate`;
- changing the recurrence pattern resets recurrence, cursor, and visible date to
  the newly selected origin.

Mobile already shares Task detail across Home and Upcoming. Web Upcoming currently
lacks the equivalent editor, so add access to Task detail there; a recurring task
must be editable regardless of which list currently shows it.

### Completion feedback

- Use the existing complete circle and single bottom Undo snackbar.
- If advancement remains overdue, update the row to the next occurrence in place
  with clear completion feedback; do not make the user wonder whether the tap
  registered.
- If advancement moves future, let the row leave Home and appear in Upcoming.
- If bounded recurrence finishes or the user selects Complete forever, remove the
  row as an ordinary completion.
- Undo restores the exact pre-completion title/date/recurrence snapshot.

Existing Home, Upcoming, project status, and waiting-until derivation continue to
read `showUpDate`; advancing a project task therefore automatically updates project
availability without recurrence-specific project logic.

## Implementation phases

### 1. Package contract runs on all target runtimes

- Create `packages/recurrence` and the public types/operations above.
- Add `chrono-node` and `rrule-temporal` as implementation dependencies.
- Implement validation, normalization, adapters, advancement, parsing, and
  canonical text.
- Add README examples, semantics, deliberate Todoist deviations, and unsupported
  scope.
- Prove import/bundle execution under Vitest, the Cloudflare Worker build, Metro,
  and an Android export before integrating persistence.

Exit: package tests, lint, and typecheck pass; no Temporal/Chrono/RRULE type leaks;
Hermes and Worker bundlers consume the package.

### 2. Task persistence and server advancement are atomic

- Add migration/schema/type/store changes.
- Add recurrence set/clear, complete, Complete forever, and conditional Undo
  operations through UserDO and routes.
- Validate all untyped JSON through the package.
- Add route/store tests for normal, replayed, stale, bounded, catch-up, completed-
  anchor, and Undo paths.

Exit: server tests prove exactly-once cursor advancement and no skipped scheduled
occurrence.

### 3. Offline clients advance and undo the same row

- Extend agent-core Task and collection contracts.
- Implement explicit optimistic recurrence verbs and persisted outbox replay.
- Update web/mobile REST adapters.
- Add in-memory and persisted collection tests, including complete → reconcile →
  Undo and two rapid catch-up completions.

Exit: package, API, agent-core, web data-layer, and mobile data-layer suites pass.

### 4. Parsing and recurrence controls ship on web and mobile

- Add live marked quick-add input and suppression state.
- Integrate one-time and recurring parsed schedules on every Task quick-add
  surface.
- Extend scheduler/detail UI for repeat create/edit/stop and Complete forever.
- Add web Upcoming Task detail access.
- Add screen tests for parsing, false-positive unrecognition, ordinary time words,
  custom patterns, overdue catch-up, every!, until, and Undo.

Exit: equivalent behavior and copy on both surfaces.

### 5. Runtime proof, documentation, and release wiring are complete

- Run touched-package tests/lint/typecheck. Full local `bin/ci` remains blocked by
  this machine's workerd limitation; GitHub CI supplies whole-repo build/deploy
  dry-run coverage.
- Device-test on the physical Pixel 7 with throwaway Tasks only; never modify the
  user's existing production tasks/projects.
- Update Task and storage docs plus project tracking.
- Add same-change user-facing changelog entries to mobile and web.
- Extend deployment/update watch paths before merge.

Exit: Pixel scenarios pass, CI is green, watch paths include the package, and all
throwaway production data is removed.

## Test strategy

### Package interface tests

Use the interface as the test surface; do not test internal adapters directly
except through diagnostic fixture helpers.

- Parameterize every date-only example from Todoist's official recurring-date and
  scheduling documentation; record source URLs and retrieval date in the fixture.
- Port tasks.org daily/weekly/monthly/yearly/lifecycle fixtures, especially:
  - January 30/31 clamp;
  - leap and non-leap February;
  - clamp then return to explicit anchor day;
  - explicit last day of month;
  - interval chains;
  - inclusive until;
  - scheduled vs completion anchor.
- Port applicable RFC fixtures from rrule-temporal for ordinal weekday, multiple
  selectors, interval phase, reverse calendar edges, and leap years.
- Test Gregorian century rules: 1900 is not leap, 2000 is leap, 2100 is not.
- Test workday cadence and ordinal workdays around weekends and month boundaries.
- Test normalized sorting/deduplication and `toText` stability.
- Test malformed JSON and unsupported schema versions.
- Test exact extraction ranges, rightmost/maximal resolution, recurrence precedence,
  and tappable suppression inputs.
- Test that time words remain ordinary:
  - `tomorrow at 3pm` consumes only `tomorrow`;
  - `every Monday at 3pm` consumes only `every Monday`;
  - `every 12 hours` returns `none`.
- Test deterministic results with explicit context and varied host `TZ` values.

### Server and collection tests

- Migration preserves every existing Task and leaves recurrence columns null.
- Add/set/clear round-trips canonical recurrence JSON.
- Replaying the same completion advances exactly once.
- Competing completions of one cursor let the first transition win and make the
  stale command harmless.
- Scheduled overdue completion advances one occurrence, even when next remains
  overdue.
- Completed-anchor recurrence advances from `completedOn`.
- Postpone changes only `showUpDate`; completion still advances from
  `recurrenceDate`.
- `until` includes the final occurrence and then completes.
- Complete forever and exhausted recurrence use ordinary revive Undo.
- Recurring Undo restores in-place after reconcile; duplicate/stale Undo is safe.
- Offline complete and Undo replay in order after restart.
- Project deletion continues to cascade recurring Tasks without extra entities.

### Surface and device scenarios

Use automated screen tests on web/mobile, then Maestro on the Pixel 7:

1. Quick-add `Pay rent every 1st`; title is cleaned and Repeat summary appears.
2. Create a deliberately overdue monthly throwaway recurrence; complete repeatedly
   and confirm each missed month appears in order rather than being skipped.
3. Create `Water plants every! 3 days`; complete and confirm next date is three
   days after local completion.
4. Postpone a scheduled occurrence past its following pattern date; complete and
   confirm the following occurrence returns overdue from `recurrenceDate`.
5. Create a recurrence ending on its current final date; complete, observe removal,
   then Undo and confirm exact restoration.
6. Complete a recurring task offline, Undo offline, reconnect, and confirm no
   double advance or collection error.
7. Type `Call Ana tomorrow at 3pm`; confirm tomorrow is applied and `at 3pm`
   remains in the title.
8. Tap an accidental `monthly` highlight in a title to unrecognize it and submit
   the unchanged plain title.
9. Remove every throwaway Task after verification.

## Documentation and changelog

- `packages/recurrence/README.md`: external interface, normalized model, parser
  context, examples, runtime support, Todoist compatibility, intentional
  deviations, and unsupported scope. This becomes the package source of truth.
- `docs/entities/task.md`: recurrence fields, cursor/display-date distinction,
  completion/Undo, API and collection verbs, and UI interactions.
- `docs/storage.md`: recurring optimistic transitions, expected-cursor idempotency,
  reconciliation, and Undo.
- `docs/todo-app.md`: shipped tracking entry and next work.
- `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md`: user-facing
  entries in the same change. Do not add this mobile/web product capability to
  the Zero assistant changelog.

## Deployment and release wiring

The new package is a real cross-package dependency and must be included anywhere
path filtering controls delivery:

- Update the Cloudflare `zero-api` Workers Builds include paths to add
  `packages/agent-core/*` (currently also a dependency but omitted) and
  `packages/recurrence/*`; read the trigger configuration back through the
  Cloudflare API after editing it.
- Add `packages/recurrence` to `.github/workflows/ci.yml` mobile-update change
  detection so package-only fixes publish an Android preview update.
- Add `packages/agent-core/**` and `packages/recurrence/**` to mobile E2E APK cache
  hashes; package code changes must not reuse an APK/bundle cache built without
  them.
- A new native build is not expected because Chrono, rrule-temporal, and the
  initial highlighted-input implementation are JavaScript-only. If highlighted
  input later requires a native rich-text dependency, treat that as a separate
  native-fingerprint decision and follow the mobile release process.

## Out of scope

- Time of day, timezone, reminders, durations, and hourly/minutely recurrence.
- Non-English parsing.
- Occurrence count.
- Completion-history/reporting/streak entities.
- Multiple materialized Task rows for future occurrences.
- Agent tools that create recurring Tasks.
- npm publication, package release automation, and public semantic-version policy.
- Deadline parsing (`{next Friday}`), priorities, labels, and projects in the
  temporal parser; the app can add those as separate quick-add modules later.

## Skills to use during implementation

- **tdd** — drive the package from Todoist/tasks.org fixtures before implementation.
- **testing** — keep tests at package, route, collection, and surface interfaces;
  cover persisted collection behavior.
- **deep-modules** — keep Chrono, RRULE, Temporal, parsing precedence, and calendar
  policy hidden behind the package interface.
- **expo-overview** — load first before mobile implementation; route to the
  relevant Expo UI/testing skills.
- **reproducible-locally** — design package and route proofs that do not require
  manual interpretation.
- **cloudflare** — update and verify Worker build watch paths.
- **changelog** — load before editing either product changelog.
- **git-commit** — commit package, product behavior, tests, docs, and changelogs
  coherently.

## Acceptance criteria

- `@zeroapps/recurrence` is one private workspace package with the documented
  `parseSchedule`, `advance`, `toText`, and `validateRecurrence` interface.
- It bundles and executes in Hermes/Metro, Vite, and Cloudflare Workers.
- Identical input/context produces identical output across runtimes and host
  timezones.
- All official English Todoist date-level examples are fixtures or explicitly
  documented as out of scope because they require time/duration support.
- Task persists validated versioned recurrence JSON and a separate
  `recurrenceDate` cursor.
- Scheduled recurrence never skips an occurrence; completed recurrence re-anchors
  from completion; one-off postpone never moves the series.
- Invalid month days clamp backward and return to their explicit anchor when valid.
- Inclusive `until` finishes the series at the correct point.
- Replayed/offline completion advances exactly once; recurring Undo restores the
  exact prior Task and stale Undo cannot roll back later work.
- Quick-add recognizes and highlights temporal text on web/mobile, supports tap-to-
  unrecognize, and leaves time words as ordinary title text.
- Users can create, inspect, edit, stop, complete forever, and Undo recurrence from
  every relevant Task surface, including web Upcoming.
- Package, agent-core, agent-api, web, and mobile tests/lint/typecheck pass; GitHub
  CI covers the whole-repo checks unavailable locally.
- Pixel 7 scenarios pass against throwaway data and all throwaway Tasks are removed.
- Mobile/web changelogs, Task/storage docs, project tracking, Worker watch paths,
  mobile update detection, and E2E cache hashes are updated in the same change.

## Risks and mitigations

- **Temporal bundle/runtime risk:** `rrule-temporal` ships a full Temporal polyfill.
  Prove Metro/Hermes and Worker bundling in phase 1 before persistence work; measure
  bundle impact and stop if startup or bundle size regresses materially.
- **Parser false positives:** every match is visible and reversible; rightmost-
  maximal resolution is centralized and fixture-tested.
- **Chrono consuming time text:** use an English date-only configuration and assert
  exact consumed ranges; never trim guessed suffixes after parsing.
- **Offline double advance:** expected `recurrenceDate` is mandatory on completion;
  server compare-and-set makes replay harmless.
- **Undo after later changes:** recompute expected post-state and conditionally
  restore; stale Undo is a no-op.
- **Schema evolution:** persist `version: 1` and validate at all untyped seams.
- **Mobile highlighted input:** prove the pure-JS implementation on the Pixel before
  broad UI wiring; do not silently degrade the selected UX.
- **Behavior drift from Todoist:** maintain sourced compatibility fixtures and
  document intentional deviations, especially overdue catch-up and postpone not
  re-anchoring the series.
