# Plan 1 — Collapse Capture into Task (the merge)

Part 1 of the `todo-single-list` series (see `todo-single-list-overview.md` for
the full settled model and the later plans). This plan is self-contained.

## Goal

Delete the **Capture** entity; make **Task** the single entry point. A quick-add
with no project creates a loose open Task that shows on Home. Task absorbs what
Capture owned — a nullable date, manual drag-reorder, and the
Captures/Upcoming visibility split — and **Refine** is removed. Capture data is
dropped; task data is preserved.

## Why (and what "absorb" really means)

Capture and Task are structural siblings today (two stores, two routes, two
collections, built deliberately alike). The split's one real payoff — a clean
`addTask` for many producers — survives as the single Task `add`; its cost (two
lifecycles, two lists, a Refine bridge) goes away. The deletion test passes:
removing `DbCaptureStore` concentrates its behavior onto `DbTaskStore` on the same
row shape rather than scattering it.

Capture is **not** "just a date" over Task. It also owns **`sortKey` + drag-
reorder** (Task has none) and the **client-side date-visibility split**
(`visibleCaptures` / `upcomingSections`; Task ignored `showUpDate`). The merge
ports all three onto Task.

## The model as it applies to this plan

Plan 1 ships everything that does **not** require date-aware *project* status.
Concretely:

- **Home** = open **and** shown-up (`showUpDate == null || <= today`) **and**
  available, where available keeps today's rule: loose (always) or a project task
  that is taken-on and whose project displays `active` (the current,
  non-date-aware `projectDisplayStatus`). One flat list ordered by `sortKey`.
- **Upcoming** = open **and** future-dated (`showUpDate > today`), grouped by day,
  no other gate.
- **Loose-task postpone works end to end:** swipe-right → tomorrow, detail-sheet
  schedule picker → any day / clear; a future date moves the task to Upcoming and
  it returns to Home on its day. (Project-task postpone interactions — activation,
  "waiting until" — are plan 3; in plan 1 a postponed *project* task correctly
  leaves Home via the shown-up gate, while its project's `active` status stays
  non-date-aware. Acceptable interim.)
- A future date parks any task in Upcoming regardless of `takenOnAt`
  (date-visibility before availability); postpone never writes `takenOnAt`.

## Merged data model (`tasks` table)

Columns after the reshape: `id`, `text`, `createdAt`, `completedAt` (open =
null), `showUpDate` (**now nullable** — a loose quick-capture has no day),
`sortKey` (**new**, nullable; unkeyed sorts last, but every row is keyed in
practice), `projectId`, `takenOnAt`, `sourceCaptureId` (kept, **dormant** —
future Refine provenance). Dropped: the whole `captures` table and the
`processedAt` concept.

`sortKey` is minted **trailing at creation** for every task (loose and project
alike), so the project task list and Home are both filtered slices of one order.

## Merged store (`DbTaskStore`, absorbing `DbCaptureStore`)

Verbs: `add` (mints trailing `sortKey`; `showUpDate` optional, defaults `null`),
`list` (open tasks in `sortKey` order, `createdAt` tiebreak — adopt Capture's
`byOrder`, nulls last, raw-codepoint compare), `complete` / `reopen`,
`setTakenOn`, `reschedule` (ported from Capture), `reorder` (ported),
`backfillSortKeys` (ported; re-point the `UserDO` init call at
`UserDO/index.ts:146` from `this.captures.backfillSortKeys()` to
`this.tasks.backfillSortKeys()`, and drop the `this.captures` store field).
Delete `process` / `unprocess` — there is no clarify step (see Lifecycle).

### Lifecycle: `process` disappears

Capture had two exits (process = clarify out; complete/stay); Task has one exit
relevant here: **complete**. After the merge a loose task leaves Home by
**complete** (done/dismiss, Todoist-style) or **postpone** (future date →
Upcoming). Promoting a loose task into a project is **plan 2**; it is out of scope
here. For plan 1, complete + postpone are the only exits. This is accepted.

## Migration (drop captures, preserve tasks)

One new migration, `0051` (latest is `0050_source_capture_id.sql`):

- **Drop `captures`** and its `captures_inbox` index. No copy.
- **Reshape `tasks`, keeping every row.** `ALTER TABLE tasks ADD COLUMN sortKey`
  (nullable). Making `showUpDate` nullable is the one step SQLite `ALTER` cannot
  do in place, so rebuild: create `tasks_new` (`showUpDate` nullable + `sortKey`),
  `INSERT … SELECT` all rows, drop old, rename, recreate the `tasks_today`
  partial index. Then `backfillSortKeys` (already called from the `UserDO` init
  block) keys the preserved rows in `createdAt` order.
- Existing tasks keep their current `showUpDate` (all non-null today); only new
  loose quick-captures use the now-allowed null. State the captures-dropped effect
  in the migration comment.

## Surfaces to change

- **Server (`apps/agent-api`):** delete `store/captures.ts` + its test, fold verbs
  into `store/tasks.ts`; delete `routes/captures.ts`; extend `routes/tasks.ts`
  with `PATCH /api/tasks/{id}` carrying `showUpDate` (nullable to clear) and
  `sortKey` (reorder); remove capture RPCs from `UserDO/index.ts`, widen task
  RPCs; the schema + migration above.
- **Shared (`packages/agent-core`):** delete `captures/` (collection, dates,
  upcoming, order, types). Add `sortKey` to the `Task` type; add `reschedule` +
  `reorder` verbs to `createTasksApi`. Move the still-needed pure helpers onto
  tasks: `orderKeyBetween` / `compareByOrder` (reorder), the shown-up date split
  (fold into `homeTasks`), `upcomingSections` (retyped over `Task`). Evolve
  `homeTasks` to `open ∧ shown-up ∧ available`. Update `quick-add/modes.ts`
  (`capture` gone, `task` default) and the barrel `index.ts`.
- **Mobile (`apps/agent-mobile`):** delete `captures-collection.ts`,
  `refine-session.ts`, `refine-banner.tsx`. Rework Home `index.tsx` into one
  reorderable task list — port `CaptureRow`'s swipe-postpone + long-press-reorder
  gesture stack onto the task row, merge the `TasksTop` plate into the one list
  (project-icon badge + park star stay as per-row affordances). Rework
  `capture-detail.tsx` into the task detail (complete + title + schedule picker;
  **no project context yet** — that arrives with plan 2). Point `upcoming.tsx` at
  tasks. Prune capture fns from `api.ts`.
- **Web (`apps/agent-web`):** mirror — `HomePage.tsx`, `UpcomingPage.tsx`, delete
  `captures-collection.ts` / `captures.ts` / `refine-session.ts`, prune
  `entity-api.ts`, update page tests.

The optimistic + offline-outbox paths already exist for tasks and for the ported
Capture verbs (including the `revive` verb behind reopen); the merge reuses the
shared collection factory — no new sync primitive.

## Test strategy (replace, don't layer)

Delete the Capture store/route/collection tests; assert the moved behavior through
the **Task** interface instead.

- **Server:** `DbTaskStore` gains reschedule/reorder/backfill coverage;
  `routes/tasks.ts` PATCH (showUpDate nullable-to-clear, sortKey) + 400/404.
- **Shared:** `homeTasks` union gate (open × shown-up × available) including
  overdue-rolls-in and future-hidden; `upcomingSections` over tasks;
  `orderKeyBetween` / `compareByOrder` retyped.
- **Web:** `HomePage` / `UpcomingPage` — one-list render, reorder, postpone,
  complete + Undo.
- **Mobile:** unit tests for the reworked Home/Upcoming, then **Pixel 7** device
  verification (Maestro): add a loose task, reorder, swipe-postpone into Upcoming,
  complete with Undo, offline replay. Pure-JS reworks hot-reload; only a brand-new
  native/`@expo/ui` surface would need an EAS dev build.

## Documentation

- Fold `docs/entities/capture.md` into `docs/entities/task.md` (Task is now the
  entry point and owns the date / reorder / visibility); delete the capture doc or
  leave a one-line tombstone pointer. Mark "Why Task is its own entity" as
  historical.
- Update `docs/todo-app.md` (entity wiki + tracking) and `docs/storage.md`.
- **Changelog (same change):** user-observable, so add a dated bullet to
  `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md` (one list,
  no separate Captures/Inbox, quick-add default is Task).

## Acceptance criteria

- No `captures` table, route, store, collection, or `Capture` type remains; the
  words Capture / Inbox / Process are gone from UI and code.
- Quick-add with no project creates a loose open Task on Home.
- Home is one reorderable `sortKey`-ordered list; loose postpone (swipe / schedule)
  moves a task to Upcoming and it returns on its day; complete raises the single
  bottom Undo.
- Upcoming lists all open future-dated tasks grouped by day, no other gate.
- Refine is gone (no banner, no session); `sourceCaptureId` dormant.
- Migration drops `captures` and preserves all `tasks` rows with nullable
  `showUpDate` + backfilled `sortKey`.
- `pnpm -F @zero/agent-api test/lint/typecheck`, agent-core + web suites pass;
  mobile is Pixel 7 device-verified.

## Risks

- **Intentional capture data loss** — state it loudly in the migration.
- **Two gates become one** — the `homeTasks` union rule is the subtle part; cover
  overdue-rolls-in, future-hidden, parked-project, taken-on-overrides-waiting.
- **Mobile gesture port** — the swipe-postpone + long-press-reorder stack was tuned
  on `CaptureRow`; port it wholesale onto the task row and re-verify on device
  (gesture arbitration bugs never show in unit tests).
</content>
