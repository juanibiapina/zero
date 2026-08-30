# Plan: Task, the first typed entity

## Goal

Introduce **Task** as a first-class entity distinct from Capture, and a **Today**
view over it. Task resolves the Capture/Today tension: Capture stays the
unclarified entry point; Task is a clarified next-action with a day. Build it as
a sibling of the existing Capture stack (own table, own store, own collection,
own view), not by bolting a date onto Capture.

## Background and decisions (settled in discussion)

- **Capture != Task.** Capture has one producer (fast human drop) and one
  consumer (later clarify). Task has many producers (human, AI, email workflow,
  project, recurring, schedule) and needs a clean verb `addTask`. That producer
  set is why Task earns entity status; a dated Capture would hide the intent and
  erode Capture's untyped/uncommitted nature.
- **Two verbs, two timestamps.** Capture gets `processedAt` (clarified out). Task
  gets `completedAt` (done). Do not conflate them.
- **Name is `Task`** (not the wiki's "Todo"; "Todo" collides with the app name).
  Reconcile the doc.
- **v1 Task is minimal:** `id`, `text`, `createdAt`, `showUpDate`, `completedAt`.
  `projectId` and `sourceCaptureId` are deferred to the Project entity and the
  Capture->Task transition respectively (no speculative columns).
- **v1 always creates a task dated today.** Reschedule (swipe-to-tomorrow), future
  dates, Capture->Task processing, the agent `create_task` tool, and Project
  membership are explicit follow-ups, not this plan.
- **Timezone lives on the client.** The server `list` returns all open
  (non-completed) tasks; the client live query filters `showUpDate <= localToday`.
  This mirrors how the Inbox filters `processedAt` in the live query, sidesteps
  the DO having no timezone, and makes "future-dated hidden until their day" and
  "overdue rolls into Today" fall out for free.
- **Entry resolves the tension via the active segment, not a toggle widget.** The
  home screen gets an Inbox | Today segmented control. The quick-add bar creates
  the entity for the segment you are viewing: on Today it mints a Task dated
  today, on Inbox a Capture. Same bar, same speed, context = the segment.
- **Per-entity store, accept duplication.** `DbTaskStore` mirrors
  `DbCaptureStore`; the Task collection mirrors the Capture collection. This is the
  2nd entity; per the data-store strategy in `docs/todo-app.md`, extract a shared
  base only at the ~3rd entity (Rule of Three). Flag the future extraction, do not
  do it now.

## Build order (web first, mobile after validation)

1. **Phase 1 - Server:** `tasks` table + migration, `DbTaskStore`, `UserDO`
   methods, `/api/tasks` routes + tests.
2. **Phase 2 - Shared (`@zero/agent-core`):** `Task` type, tasks collection,
   `todayView`, exports.
3. **Phase 3 - Web:** Inbox | Today segments on `apps/agent-web`, quick-add
   creates a today-dated task, circle completes, client filters
   `showUpDate <= localToday`. **Validate the UI here.**
4. **Gate - validate web:** confirm the Today interaction, the segment switch, the
   entry-by-active-segment model, overdue rollover, empty/loading states. Adjust
   the design before it gets copied to mobile.
5. **Phase 4 - Mobile:** `tasks-collection.ts` (separate SQLite + outbox), home
   segmented control, Today screen. Only after web is validated. Carries the EAS
   dev-build cost for the new `@expo/ui` segment.
6. **Phase 5 - Docs + changelog:** `docs/entities/task.md`, reconcile `capture.md`
   + `todo-app.md`, web CHANGELOG when Phase 3 lands, mobile CHANGELOG when Phase 4
   lands.

Rationale: web has no EAS build cost and no device loop, so the design iterates
fast there. The shared `@zero/agent-core` layer (Phase 2) is proven by web, so
mobile reuses it unchanged; validating web validates most of mobile's logic too.
Mobile then becomes near-mechanical: wire the proven collection to op-sqlite +
outbox and mirror the validated web screen.

## Architecture reference (what Task mirrors)

Capture spans these, and Task gets a parallel at each:

- Server table `captures` (`apps/agent-api/src/UserDO/db/schema.ts`) + partial
  index migration.
- `DbCaptureStore` (`apps/agent-api/src/store/captures.ts`): domain methods
  `add` / `list` / `process`.
- `UserDO` methods `addCapture` / `listInbox` / `processCapture`
  (`apps/agent-api/src/UserDO/index.ts`).
- REST routes (`apps/agent-api/src/routes/captures.ts`), mounted in `app.ts`,
  tested in `captures.test.ts` against a fake UserDO.
- Shared `Capture` type + `createCapturesApi` collection + `inboxView` helper in
  `@zero/agent-core` (`packages/agent-core/src/captures/`), re-exported from its
  `index.ts`.
- Mobile wiring `apps/agent-mobile/src/lib/captures-collection.ts` (op-sqlite
  persistence + offline outbox, separate DB files) and the screen
  `apps/agent-mobile/src/app/(signed-in)/index.tsx`.
- Web screen `apps/agent-web/src/pages/InboxPage.tsx`.

## What to change and why

### Phase 1 - Server (the Task entity + verbs)

1. **Schema + migration.** Add a `tasks` table (`id` PK client-minted UUID,
   `text` notNull, `createdAt` notNull, `showUpDate` notNull, `completedAt`
   nullable). Add migration `0043_tasks.sql` and a partial index `tasks_today` on
   `("showUpDate")` `WHERE "completedAt" IS NULL` (mirrors `captures_inbox`).
   Register both in `migrations.ts`.
2. **`DbTaskStore`** (`apps/agent-api/src/store/tasks.ts`), standalone from the
   agent Store like `DbCaptureStore`. Domain methods:
   - `add(id, text, showUpDate)` - dedupe on `id` (client-minted, exactly-once on
     replay), same pattern as capture add.
   - `list()` - all open tasks (`completedAt IS NULL`), oldest-first. Date filter
     is client-side.
   - `complete(id)` - set `completedAt`, return updated row or null.
3. **`UserDO` methods** `addTask` / `listTasks` / `completeTask` delegating to the
   store.
4. **REST routes** (`apps/agent-api/src/routes/tasks.ts`), mounted in `app.ts`:
   - `GET /api/tasks` -> `{ tasks }` (open tasks).
   - `POST /api/tasks { id, text, showUpDate }` -> `201 { task }`; `400` on empty
     text, non-UUID id, or bad date.
   - `POST /api/tasks/{id}/complete` -> `200 { task }` or `404`.
   - Emit logs `task_added` / `task_completed` (mirror `capture_added`).

### Phase 2 - Shared data layer (`@zero/agent-core`)

5. **`Task` type** (`packages/agent-core/src/tasks/types.ts`):
   `{ id, text, createdAt, showUpDate, completedAt }`.
6. **Tasks collection** (`packages/agent-core/src/tasks/collection.ts`): mirror
   `captures/collection.ts` - `TasksRest` (`fetchTasks` / `addTask` /
   `completeTask`), `createTasksApi` with the same durable-persist-else-in-memory
   fallback, optimistic row minted client-side, `reconcile` on the stable id,
   offline outbox mutationFns `addTask` / `completeTask`. Reuse the same tested
   reconcile-diff shape. Distinct `TASKS_QUERY_KEY = ["tasks"]` and persisted
   collection id `"tasks"`.
7. **`todayView` helper** (`packages/agent-core/src/tasks/view.ts`): the same
   rows/loading/empty/error rule as `inboxView`, so both screens share one tested
   rule.
8. Export the new surface from `packages/agent-core/src/index.ts`.

### Phase 3 - Web

9. Inbox | Today segments on `apps/agent-web`, reusing the shared
   `createTasksApi` + `todayView`. The Today live query filters
   `completedAt IS NULL AND showUpDate <= localToday`, orders by `showUpDate` then
   `createdAt`. The quick-add on the Today segment mints a Task with
   `showUpDate = local today (YYYY-MM-DD)`. Circle tap = complete.

### Phase 4 - Mobile (after web validation)

10. **`tasks-collection.ts`** (`apps/agent-mobile/src/lib/`): mirror
    `captures-collection.ts` with **separate** SQLite files (`zero-today.sqlite`,
    `zero-today-outbox.sqlite`) so the two entities never share a table or outbox.
11. **Home screen segmented control**
    (`apps/agent-mobile/src/app/(signed-in)/index.tsx`): Inbox | Today segment
    above the list; the Today list and quick-add mirror the validated web screen.
    Note: a segmented control is a new `@expo/ui` component; its first use needs a
    fresh EAS dev build to run on device (pure-JS changes hot-reload).

### Phase 5 - Docs and changelog

12. New `docs/entities/task.md` documenting Task's cross-system interactions (the
    Minecraft-block pass), including the deferred columns and follow-ups.
13. Update `docs/entities/capture.md` "Interactions/Other entities" and "Next" to
    point at Task and the future Capture->Task transition.
14. Update `docs/todo-app.md`: move the Today/Task work from "Next" into tracking;
    reconcile the wiki's "Todo" naming to "Task"; record the Rule-of-Three note
    (extract a shared entity base at entity #3).
15. `apps/agent-web/CHANGELOG.md` entry when Phase 3 lands;
    `apps/agent-mobile/CHANGELOG.md` entry when Phase 4 lands. No agent-api
    changelog entry (that file ships to agent users; the todo app is a separate
    surface, per AGENTS.md).

## System-wide impact

- New DO SQLite table in the per-user `UserDO`; migration is additive, no data
  touched.
- New REST surface under `/api/tasks`; no change to `/api/captures`.
- Mobile gains a second offline outbox and SQLite database; kept in separate files
  so a schema reset of one never wipes the other.
- The home screen gains state (active segment) and a second data layer built
  alongside the first, in the signed-in tree where the Clerk token getter is valid
  (same as `useCapturesApi`).

## Test strategy

- **TDD, server first.** `tasks.test.ts` mirrors `captures.test.ts` against a fake
  UserDO: add returns the row and dedupes on id; list returns open tasks
  oldest-first and excludes completed; complete flips `completedAt` and 404s an
  unknown id; `GET` reflects state. Assert the date filter is NOT applied
  server-side (list returns future-dated too).
- **Shared helpers.** Unit-test `todayView` (mirror `view.test.ts`) and the tasks
  reconcile-diff (mirror `collection.test.ts`), the pure pieces, with no
  persistence stack.
- **Client date filter.** A test that the Today live query includes overdue
  (`showUpDate < today`) and today, and excludes future and completed.
- **Web screen:** switching to the Today segment and submitting creates a task
  dated today and it appears; completing it removes it.
- **Device (mobile phase only, Maestro, Pixel 7):** add a today task, complete it,
  switch segments. Needs a fresh EAS `preview`/`production` build for the new
  segmented control and to exercise the durable-snapshot path (the dev client
  falls back to in-memory). This box has no emulator/workerd; verify via unit
  tests + `expo export` + the phone.
- Replace, don't layer: test at each new module's interface (store via routes,
  collection via its api, view via the helper), not internal state.

## Skills to use

- **tdd** - server store + routes and the shared helpers, red-green-refactor.
- **testing** - deciding what to fake at each seam (the fake UserDO for routes,
  in-memory collection fallback under jest).
- **vocabulary / deep-modules** - keep `DbTaskStore` and the Task collection deep
  and per-entity; hold the line against a premature generic bag (extract at entity
  #3).
- **impeccable / expo-ui** - the Today screen and the segmented control (web
  first, then `@expo/ui` on mobile).
- **changelog** - the web (and later mobile) CHANGELOG entries, routed per
  AGENTS.md.
- **documentation** - the new/updated docs and code comments.
- **reproducible-locally** - device verification plan for the mobile surface.
- **git-commit** - commit the code and its changelog/doc updates together.

## Acceptance criteria

- A `tasks` table and `/api/tasks` exist; adding is exactly-once on the
  client-minted id; completing flips `completedAt`; list returns open tasks and
  excludes completed.
- Web home has Inbox | Today segments. On Today, the quick-add creates a task
  dated today; the circle completes it; the list shows overdue + today and hides
  future + completed.
- Capture behavior is unchanged.
- `@zero/agent-core` exports `Task`, `createTasksApi`, `todayView`; the web screen
  uses them (mobile reuses them in Phase 4).
- `docs/entities/task.md` exists, `capture.md` and `todo-app.md` are reconciled
  (Task naming, tracking moved), and the web CHANGELOG has an entry.
- Server tests and shared-helper tests pass; `pnpm --filter @zero/agent-api run
  test` (plus lint/typecheck) green.
- Mobile (Phase 4) keeps a separate SQLite file and outbox for tasks; device flow
  verified on a standalone build.

## Risks, dependencies, mitigations

- **Duplication with the Capture stack.** Accepted deliberately (Rule of Three).
  Mitigate by keeping the two stacks structurally identical so the future
  extraction at entity #3 is mechanical; note it in `todo-app.md`.
- **Local-date correctness.** Filtering by `showUpDate <= localToday` on the
  client avoids DO timezone bugs; store `showUpDate` as a local `YYYY-MM-DD`
  string minted by the client. Test overdue/today/future boundaries.
- **New `@expo/ui` segmented control needs a fresh EAS dev build** before it runs
  on device; pure-JS list logic hot-reloads. Plan the build into the mobile-phase
  verification.
- **Two offline outboxes on mobile.** Separate DB files prevent cross-wipes; the
  leadership/online-detector wiring is copied verbatim from the proven capture
  path.
