# Plan: show and sort by "waiting time" in the Projects list

## Goal

In the Projects list, each project in the **Waiting** section shows how long it
has been waiting (a readable phrase like "3 days"), and that section is ordered
**oldest-first** (the longest-waiting project at the top). Web and mobile behave
identically. No data-model change.

## Background a fresh agent needs

- A project's status is **derived on the client, not stored**
  (`projectDisplayStatus` in `packages/agent-core/src/projects/derive.ts`). A
  project displays `waiting` when it has >=1 unresolved waiting condition and
  nothing taken on. There is therefore **no "entered waiting" timestamp** in the
  data.
- The only available "blocked since" signal is `createdAt` on each
  `WaitingCondition` (`packages/agent-core/src/waits/types.ts`). A project blocked
  by several conditions has been waiting since its **oldest unresolved** one.
  Structured kinds (`task-done`, `project-status`) also carry `createdAt`, so the
  signal is uniform across kinds.
- The list is grouped by `projectsByStatus` (`projects/sections.ts`), which today
  sorts **every** section by `project.createdAt` ascending. Both surfaces already
  run a live query over the waits collection (`conds`) and pass
  `projectDisplayStatus` into `projectsByStatus`, so the waiting-condition data is
  already in hand on both the web screen
  (`apps/agent-web/src/pages/ProjectsPage.tsx`) and the mobile screen
  (`apps/agent-mobile/src/app/(signed-in)/projects/index.tsx`).

## Decisions already made (and why)

- **What "waiting time" measures:** elapsed time since the project became blocked,
  proxied by the `createdAt` of its **oldest unresolved condition**. Status is
  derived, so no "entered waiting" timestamp exists; the oldest open condition is
  the available, meaningful "blocked since" instant.
- **Format = readable phrase, not a terse token.** The badge reads "3 days" /
  "2 months", not "3d". More humane and on-brand for a Todoist/Things-style app,
  and readable without decoding. The section header already says "Waiting", so the
  badge carries only the magnitude; the accessible label expands it ("Waiting 3
  days").
- **Library = `date-fns`, `formatDistanceToNowStrict`.** Chosen after comparing
  `Intl.RelativeTimeFormat` (built-in but only "N ago" phrases, no auto-unit),
  `javascript-time-ago` (best for a *terse* token via its `mini` style), and
  `date-fns`. For a **readable phrase without "ago"**, `formatDistanceToNowStrict`
  is the cleanest: a single call yields a single-unit phrase with no "about/almost"
  fuzz — "3 minutes", "5 hours", "2 days", "3 months", "1 year". It is modern
  (v4.1, 2024), actively maintained, tree-shakeable, and works on Expo/Hermes
  today (the 2019 Hermes bug was v1/v2; v3/v4 ship dual CJS+ESM that Metro
  resolves). `javascript-time-ago`'s phrase style always appends "ago" (wrong
  tense for an ongoing wait), and forcing date-fns into a terse token would need a
  ~16-token custom locale — neither is wanted here.
  - **Future watch item (not blocking):** date-fns v5 will be ESM-only, and Expo
    has flagged some ESM-only packages as incompatible with Metro's ESM
    resolution. v3/v4 are safe now.

## What to change

### 1. `packages/agent-core/src/projects/derive.ts` — the waiting-since seam

Add one pure helper, next to the rest of the waiting derivation for locality:

```ts
// The instant a project started waiting: the createdAt of its oldest unresolved
// condition, or null when the project is not waiting. Reuses unresolvedConditions
// so it stays consistent with what "waiting" means (a resolved or code-satisfied
// condition never counts).
export function waitingSince(
  project: Project,
  tasks: Task[],
  conditions: WaitingCondition[] = [],
  projects: Project[] = [],
): string | null
```

Implementation: `unresolvedConditions(project, conditions, tasks, projects)`, then
return the minimum `createdAt` among them (string compare on ISO timestamps is
correct), or `null` when the set is empty. Export from
`packages/agent-core/src/index.ts` next to `projectDisplayStatus`.

### 2. `packages/agent-core/src/projects/waiting-label.ts` (new) — the label

Add `@zero/agent-core` dependency on `date-fns`, and a thin pure wrapper so the
date-fns call lives in one tested place and the screens stay presentation-only:

```ts
import { formatDistanceStrict } from "date-fns/formatDistanceStrict";

// Readable "how long waiting" phrase for a blocked-since instant, e.g. "3 days",
// "2 months". No "ago" suffix (the Waiting section header already frames it, and
// the wait is ongoing, not a past event). `now` is injectable for tests.
export function waitingLabel(sinceIso: string, now: Date = new Date()): string {
  const since = new Date(sinceIso);
  if (now.getTime() - since.getTime() < 60_000) return "just now"; // sub-minute floor
  return formatDistanceStrict(since, now, { addSuffix: false });
}
```

- Use the **subpath import** `date-fns/formatDistanceStrict`, not the barrel, so
  Metro (weaker tree-shaking than Vite) bundles only that function on mobile.
- `formatDistanceStrict(since, now)` takes **both** endpoints, so an injected
  `now` makes `waitingLabel` deterministic in tests; the default `now = new
  Date()` gives the "to now" behavior in production. (The `…ToNow…` variant reads
  `Date.now()` internally and is not injectable — avoid it for this reason.)
- The sub-minute floor returns "just now" before calling date-fns (see Badge
  style), so a just-created condition never reads "0 seconds".
- Export `waitingLabel` from `index.ts`.

### 3. `packages/agent-core/src/projects/sections.ts` — pluggable sort key

Add an optional third parameter so the Waiting section can order by waiting-since
without `projectsByStatus` having to know about conditions:

```ts
export function projectsByStatus(
  list: readonly Project[],
  statusOf: (p: Project) => ProjectStatus = (p) => p.status,
  sortKeyOf: (p: Project) => string = (p) => p.createdAt, // NEW, default = today
): ProjectSection[]
```

Each section sorts ascending by `sortKeyOf`. Callers pass
`sortKeyOf = (p) => waitingSince(p, tasks, conds, list) ?? p.createdAt`. Because
`waitingSince` is non-null **only** for waiting projects and every section is
homogeneous by status, this sorts the Waiting section oldest-first (longest wait
on top) while every other section keeps its current `createdAt` order. One
optional param, fully backward compatible.

### 4. Web list — `apps/agent-web/src/pages/ProjectsPage.tsx`

- Pass the new `sortKeyOf` into `projectsByStatus`.
- Compute a per-project label (`waitingSince` + `waitingLabel`) and thread an
  optional `labelOf(project) => string | null` through `ProjectSectionView` into
  the row. Render a muted, right-aligned badge only when non-null (so only Waiting
  rows show it). Set `aria-label="Waiting 3 days"` on the badge.

### 5. Mobile list — `apps/agent-mobile/src/app/(signed-in)/projects/index.tsx`

- Pass the same `sortKeyOf` into `projectsByStatus`.
- `ProjectRow` gains an optional trailing muted label via `ListRow`'s trailing
  slot, shown only for waiting rows, with an `accessibilityLabel` of "Waiting 3
  days".

No table, migration, store, API, or collection change — this is pure client
derivation over data both screens already load.

## Badge style

The badge is **metadata, not content**: the Waiting section header already frames
the meaning, so the badge carries only the magnitude, rendered in the app's
restrained style. Decisions (grounded in the existing design system):

- **Plain muted text, no pill/chip background.** A filled chip would compete with
  the emoji icon and title and break the flat Todoist row aesthetic. The row is
  already a card (web) / hairline-divided row (mobile); the badge is just a quiet
  trailing label.
  - Mobile: reuse the `caption` text variant (`text-caption
    text-foreground-secondary`) in `ListRow`'s `trailing` slot — already the
    muted, small metadata style.
  - Web: `text-sm text-muted-foreground` (the existing muted token), placed as a
    right-aligned trailing element with `shrink-0` and a small left margin.
- **No icon** (no clock/hourglass). The section header frames it; a glyph adds
  clutter for no information.
- **Right-aligned, vertically centered, `shrink-0`.** A long project title
  truncates before the badge, never the reverse. Mobile's `ListRow` already lays
  the trailing slot out this way (`flex-row items-center gap-3`, body is
  `flex-1`); on web give the title `flex-1 truncate` and the badge `shrink-0`.
- **Uniform muted color at every age — no escalation to amber/red.** Considered
  and rejected: warming the color as the wait grows. The codebase is explicitly
  "Things-3 gentle overdue, no red" (see the comment in `captures/dates.ts`), and
  the list is already sorted longest-first, so the stalest projects surface at the
  top without a color alarm. Keeping one muted color honors that aesthetic.
- **Floor tiny waits to "just now".** `formatDistanceToNowStrict` emits
  "0 seconds" / "30 seconds" for a just-created condition, which reads as noise.
  In `waitingLabel`, if the elapsed time is under a minute return "just now";
  otherwise the strict phrase ("5 minutes", "3 hours", "2 days", "2 months",
  "1 year"). This floor lives in the pure helper, so both surfaces share it and it
  is unit-tested.
- **No tabular numerals.** The phrase format varies its unit word, so digit
  alignment buys nothing; default type is fine.

## Tests

- `packages/agent-core/src/projects/derive.test.ts`: `waitingSince` returns `null`
  when not waiting, the min `createdAt` across multiple open conditions, and
  ignores resolved / code-satisfied conditions.
- `packages/agent-core/src/projects/waiting-label.test.ts`: `waitingLabel` with a
  fixed `now` yields "just now" under a minute, then "5 minutes", "3 hours",
  "3 days", "2 months", "1 year" across unit boundaries.
- `packages/agent-core/src/projects/sections.test.ts`: with `sortKeyOf` supplied,
  the waiting section orders by the key ascending while other sections keep
  `createdAt` order; default (no arg) is unchanged.
- `apps/agent-web/src/pages/ProjectsPage.test.tsx`: a waiting project renders its
  duration badge; two waiting projects render longest-first.
- `apps/agent-mobile/src/app/(signed-in)/__tests__/projects.test.tsx`: badge
  renders on a waiting row; ordering is longest-first.
- **Pixel 7 device verification (required by AGENTS.md):** badge shows, Waiting
  section is ordered longest-first. date-fns is pure JS (no native module), so no
  EAS rebuild is expected — but **confirm the `date-fns/formatDistanceToNowStrict`
  subpath import bundles under Metro on device**. Restore any mutated data (dev
  client hits production).

## Docs

- `docs/entities/project.md` (UI + derived-status sections) and
  `docs/entities/waiting-condition.md`: note that a waiting project shows how long
  it has been blocked (oldest unresolved condition's `createdAt`) and that the
  Waiting section is ordered longest-waiting first.
- `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md`: a
  user-facing bullet each (`- YYYY-MM-DD: ...`, most recent first). **Not**
  `apps/agent-api/CHANGELOG.md` (this is the todo app, not the agent).

## Skills to use

- **tdd** — write the `waitingSince` / `waitingLabel` / `sections` tests first,
  then the helpers.
- **testing** — the pure helpers are the test surface; assert through
  `projectsByStatus` / `waitingLabel`, not internals.
- **changelog** — when adding the mobile/web changelog bullets.
- **git-commit** — commit code + tests + docs + changelog together.
- **open-pr** — to send for review.

## Acceptance criteria

- Each waiting project shows a readable "how long waiting" phrase ("3 days") from
  its oldest unresolved condition; non-waiting rows show none.
- The Waiting section is ordered oldest-first (longest wait on top); all other
  sections keep their `createdAt` order.
- Label and order come from the **same** `waitingSince` value (no drift).
- New unit tests pass; web and mobile screen tests cover badge + ordering;
  verified on the Pixel 7.
