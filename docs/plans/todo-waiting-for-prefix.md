# Plan: "for <elapsed>" prefix on past-waiting badges

## Goal

A waiting project's badge reads with a preposition that matches the direction of
its wait. A future date wait already reads **"until Wednesday, Jul 15"**. A
condition wait, which is a wait that started in the past, reads a bare
**"5 months"** today. Change it to **"for 5 months"** so both badges are a
preposition + a time phrase and parallel each other.

## Background

A project on the Projects list shows one Waiting badge, produced by the single
pure module `waitingBadge` (`packages/agent-core/src/projects/waiting-badge.ts`).
A project waits for exactly one reason at a time and the badge picks its label
from that reason:

- **Condition wait** (an open free-text/task-done/project-status condition): the
  wait began at a recorded past instant (`waitingSince`), so the label is the
  elapsed duration from `waitingLabel(since, now)` — e.g. `"5 months"`,
  `"3 days"`, `"just now"`. This is the "in the past" case the request names.
- **Date wait** (a future-dated taken-on task): the wait ends on a future day
  (`waitingUntil`, which only ever returns a day `> today`), so the label is
  `"until " + dayLabel(until, today)` — e.g. `"until Tomorrow"`. This is the
  "in the future" case.

Both surfaces (web `apps/agent-web/src/pages/ProjectsPage.tsx` and mobile
`apps/agent-mobile/src/app/(signed-in)/projects/index.tsx`) render
`waitingBadge(...).label` verbatim, so a change in the one module updates both.

The project **detail** "Waiting on" section (`projects/[id].tsx`) does not show
an elapsed duration — it lists each condition's own label and, separately, an
auto `"until <day>"` row — so it needs no change. This plan touches only the
badge.

## What to change and why

1. **`waitingBadge` condition branch** — prefix the elapsed label with `"for "`:
   `label: \`for ${waitingLabel(since, now)}\``. This is where the parallel
   "for"/"until" framing belongs: both prepositions live in one place, so the two
   waiting reasons stay consistent by construction. `waitingLabel` stays a pure
   duration phrase with no preposition (its only caller is `waitingBadge`, but
   keeping it preposition-free keeps its single responsibility clear and its
   existing tests intact).

2. **"just now" edge** — `waitingLabel` floors a sub-minute wait to `"just now"`;
   `"for just now"` reads wrong. Guard it: when the elapsed label is `"just now"`,
   use it unprefixed; otherwise prefix `"for "`. This is a rare state in a
   Waiting list (a project blocked for under a minute), but the guard keeps the
   badge grammatical. Keep the guard inside `waitingBadge` next to the prefix.

The date-wait branch and both sort keys (`a:`/`b:`) are unchanged; ordering is
unaffected.

## Out of scope

- The project detail "Waiting on" section — it shows no elapsed duration.
- `waitingLabel` itself — it stays preposition-free; no `"ago"`/`"for"` inside it.
- Any change to which reason wins, to sort keys, or to the "just now" floor value.

## Tests to add or update

- `packages/agent-core/src/projects/waiting-badge.test.ts`
  - Update the existing "labels a condition wait…" assertion from `"5 months"`
    to `"for 5 months"`.
  - Add a case: a condition created under a minute before `now` yields the
    unprefixed `"just now"` (not `"for just now"`).
  - Confirm the date-wait case still asserts `"until Wednesday, Jul 15"`.
- `packages/agent-core/src/projects/waiting-label.test.ts` — no change;
  `waitingLabel` still returns bare durations.

## Docs to add or update

- `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md` — one dated
  bullet each, from the user's view, e.g.: "A project waiting on a condition now
  shows how long it's been waiting as 'for 5 days', matching the 'until <day>'
  label on projects waiting for a date." Both, because the shared badge renders
  on both surfaces.

## Skills to use

- `tdd` — update the badge test first (red on `"for 5 months"`), then make the
  one-line change green.
- `git-commit` — commit the code, tests, and both changelog bullets together.

## Acceptance criteria

- `waitingBadge` returns `"for 5 months"` (was `"5 months"`) for a condition
  wait, and `"just now"` (unprefixed) for a sub-minute condition wait.
- The date wait still returns `"until <day>"`; sort keys unchanged.
- `pnpm --filter @zero/agent-core run test` and `... run typecheck` pass.
- Both changelog files carry the new bullet, committed with the change.
