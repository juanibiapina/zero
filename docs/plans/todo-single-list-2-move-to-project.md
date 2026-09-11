# Plan 2 — Move a loose task to a project

Part 2 of the `todo-single-list` series (see `todo-single-list-overview.md` for
the full settled model). Plan 1 (the merge) is shipped: Capture is gone, Task is
the single entity, and `PATCH /api/tasks/{id}` already carries text / showUpDate /
sortKey / takenOnAt through one verb-per-field endpoint. This plan is
self-contained.

## Goal

Let a task be assigned to a project (and back to loose) from its detail screen,
on web and mobile. This is the deliberate replacement for the **clarify/process**
step the merge removed: a raw thought in your one list becomes project work
without retyping it. After this, a loose task's exits are complete, postpone,
**and move-to-project**.

## Why this slice, and why now

The merge left exactly one gap on purpose. With `process` and Refine gone, the
only ways to clear a loose task were complete and postpone, so a loose task you
wanted to file under a project had to be completed and retyped there. This plan
closes that gap and nothing more. It is small and isolated because the plumbing
already exists: **`projectId` is already a live nullable column on `tasks`**
(migration `0047_tasks_project_id.sql`), already on the `Task` type, and already
accepted by the `add` path (store, POST route, and `addTask` collection verb) — so
a task can be *created* under a project today. What is missing is any way to
*mutate* `projectId` after creation. **This plan adds no column and no new
entity — it adds the update path only.** The verb-per-field PATCH added in plan 1
is the exact seam a `projectId` field slots into. It sits between the merge and
the larger date-aware availability rework (plan 3).

The deletion test on the alternative — a bespoke "move" endpoint — fails: it would
duplicate the PATCH dispatch, validation, RPC, and optimistic-update machinery
that already exists for four fields. Adding a fifth field to the deep PATCH verb
adds capability with almost no new interface.

## The one real decision: what happens to `takenOnAt` on move

**Moving a task into a project clears `takenOnAt`; moving it back to loose leaves
`takenOnAt` untouched.**

Rationale: a loose task is always on Home (the curation gate only applies to
project tasks). Once a task belongs to a project it must obey that project's
curation — taken-on **and** the project displays active — rather than silently
staying on Home. So filing a loose task under a project parks it (clears
`takenOnAt`); it surfaces on the project screen to be groomed, exactly like any
other project task. Moving a task out to loose makes it always-visible again;
`takenOnAt` is meaningless for a loose task, so there is nothing to clear.

`sortKey` is **preserved** across the move (one global order; see the overview).
The task simply also becomes a filtered member of the project's slice. No re-mint.

### Where the `takenOnAt` clear lives: the server owns it

The store verb `setProject(id, projectId)` clears `takenOnAt` atomically when
`projectId` is non-null, so the invariant ("a project task is never silently
taken-on from its loose past") is enforced in one place regardless of caller. The
wire then carries a single intent — `PATCH { projectId }` — and an offline replay
stays a single-field write. The optimistic client update mirrors the same rule
(clear `takenOnAt` locally when the target project is non-null) so the row leaves
Home instantly.

Alternative considered and rejected: the client sends both `projectId` and
`takenOnAt: null` in one PATCH. It works (the PATCH handler already applies each
present field via its own verb) but splits the invariant across client and wire,
and makes the offline-replay payload two-field. Server-owns is cleaner.

## What changes, by layer

The pattern to copy for every layer is the existing `reschedule` field
(nullable, same PATCH endpoint, same optimistic-update shape). `projectId` is its
structural twin (a nullable id instead of a nullable date).

### Server (`apps/agent-api`)

- **`store/tasks.ts` — `setProject(id, projectId: string | null): Task | null`.**
  Update `projectId`; when `projectId != null` also set `takenOnAt = null` in the
  same update. Idempotent on the id; returns the updated row or null when absent.
  Mirror the existing `reschedule` verb's shape and comment.
- **`UserDO/index.ts` — `setTaskProject(id, projectId)` RPC** delegating to
  `this.tasks.setProject`, alongside the existing `rescheduleTask` / `reorderTask`
  RPCs.
- **`routes/tasks.ts` — widen the PATCH body** with
  `projectId: z.string().uuid().nullable().optional()`. In the handler add
  `hasProjectId = "projectId" in body` to the empty-body guard, and dispatch
  `userDO.setTaskProject(id, body.projectId ?? null)` with a `task_moved` log
  line. `projectId` uses `"projectId" in body` (presence), not `!== undefined`,
  because `null` is a valid clear-to-loose value — the same distinction the route
  already draws for `showUpDate` and `takenOnAt`.

### Shared (`packages/agent-core`)

- **`tasks/collection.ts` — a `moveToProject` update verb + a `moveToProject`
  action on `TasksApi`.**
  - `TasksRest`: add `setTaskProject(id, projectId: string | null): Promise<Task>`.
  - New verb `moveToProject` (`v.update`): `draft` sets `draft.projectId = projectId`
    and, when `projectId != null`, `draft.takenOnAt = null`; `persist` calls
    `rest.setTaskProject(id, modified.projectId)`.
  - **Verb routing order is load-bearing (in-memory path only).** On the
    in-memory fallback path, `routeUpdate` (in `collection/base.ts`) picks the
    first verb whose `matches` returns true, in verb-table declaration order,
    reading the **`changes`** field set (never `modified`); the current order is
    reorder (`sortKey`) → reschedule (`showUpDate`) → complete (`completedAt`,
    the one that reads `modified`) → take-on (`takenOnAt`) → edit (catch-all).
    A move into a project changes **both** `projectId` and `takenOnAt`, so
    `moveToProject` must sit **before** the take-on verb and match on
    `"projectId" in changes`; placed after take-on it would misroute to take-on.
    Add it right before `setTakenOn` and extend the routing comment. (The durable
    offline path does not route by `matches` at all — it keys each queued write by
    the verb's *name* — so this ordering matters only for the in-memory fallback,
    but both paths share one verb table, so the fix is one edit.)
  - `TasksApi.moveToProject(id, projectId)` → `api.actions.moveToProject({ id, projectId })`.
- **No change to `homeTasks` / availability.** The existing non-date-aware gate
  already excludes a parked project task from Home; clearing `takenOnAt` on move
  is what makes the moved task obey it. Plan 3 owns the date-aware gate.

### Clients (web + mobile) — a Project row + picker on the task detail

The plan-1 detail was intentionally minimal (title + schedule). Add a **Project
row** below the schedule row that shows the current project (icon + title, or "No
project") and opens a **project picker**: the list of the user's projects plus a
"No project" option. Picking writes `moveToProject` and closes the picker.

- **Mobile (`apps/agent-mobile`).** The detail is the `useTaskDetail` hook in
  `src/components/task-detail.tsx`, shared by Home (`index.tsx`) and Upcoming
  (`upcoming.tsx`). Give the hook the projects it needs and a picker sheet:
  - Add a `projects: Project[]` param to `useTaskDetail`. **Home already reads
    projects** via `useProjectsApi` (it resolves each row's icon from them);
    **Upcoming does not** — add a `useProjectsApi` + live query to `upcoming.tsx`
    and pass the list in. Because both screens share the hook, wiring the picker
    once gives move-to-project on both Home and Upcoming.
  - Add a `ProjectPickerSheet` (a plain RN modal like the existing
    `ScheduleSheet`): a "No project" row + one row per project (its `icon` + `title`).
  - Add a Project row to `TaskDetailSheet` (mirrors the schedule row) that opens
    the picker; label shows the current project's icon+title or "Project".
  - On pick: `api.moveToProject(selected.id, projectId)`, surface errors via the
    existing `onError`/`tx.isPersisted.promise` path, close the picker. When the
    move drops the task out of the screen's `list` (a loose Home task filed into a
    project + `takenOnAt` cleared), the sheet auto-closes via the existing
    `list.find(id)` resolution — the same mechanism reschedule already relies on.
  - Extend `handleBack` / `active` to account for the picker being open.
- **Web (`apps/agent-web`).** `HomePage.tsx` owns its own inline detail sheet
  (not the shared hook) and the same scheduler pattern, and **already reads the
  projects collection** (its `iconOf` resolves row icons). Add the mirrored
  Project row + picker to that detail, calling the web `moveToProject`.
  - **Web Home/Upcoming asymmetry (decision).** Web `UpcomingPage.tsx` is a thin
    screen with only an inline text editor — it has **no** detail sheet or
    scheduler, so it cannot host the project picker without new work. Mobile does
    not have this gap (Home and Upcoming share `useTaskDetail`). **v1 scope: add
    move-to-project to web Home only.** Consequence: a *future-dated loose* task
    (which on web lives only in Upcoming) can't be filed on web until it returns
    to Home; on mobile it can be filed from Upcoming. This is an accepted, stated
    interim gap, not a silent one. Extending web Upcoming (promoting the detail
    into a shared web component, or giving Upcoming its own) is deferred; revisit
    if the gap bites.
- **REST wiring.** Add `setTaskProject(id, projectId)` to `apps/agent-web/src/lib/tasks.ts`
  (same-origin `PATCH { projectId }`) and to `apps/agent-mobile/src/lib/api.ts`
  (Bearer `PATCH { projectId }`), each a copy of the existing `rescheduleTask`
  helper. Bind it in each client's `TasksRest` (web `tasks-collection.ts`, mobile
  `tasks-collection.ts`).

## Out of scope

- Creating a new project from the picker (pick existing only for v1).
- Bulk move / multi-select.
- A row action (swipe / ⋯) to move without opening the detail — the detail row is
  enough for v1.
- Move-to-project from **web Upcoming** — web Upcoming has no detail sheet today;
  giving it one (or a shared web detail) is deferred (see the web asymmetry
  decision). Mobile Upcoming is in scope (it shares the detail hook).
- Any change to project `active`/`waiting` derivation or the Home availability
  gate (plan 3).
- Moving *between* projects needs no extra code (same verb); only the UI copy
  reads "Move to project", not "Add".

## Test strategy (replace, don't layer; assert through each interface)

- **Server (`store/tasks.test.ts`, `routes/tasks.test.ts`):** `setProject` sets
  `projectId`, clears `takenOnAt` when the target is non-null, leaves `takenOnAt`
  when clearing to loose, and is idempotent on replay; PATCH accepts a uuid and
  `null`, rejects a malformed id (400), 404s an unknown id, and the empty-body
  guard still fires when no field is present.
- **Shared (`tasks/collection.test.ts`):** the `moveToProject` optimistic update
  moves the row and clears `takenOnAt` for a non-null target (and does not clear
  it for a null target); it routes to the right verb given the field set (the
  `projectId`-before-`takenOnAt` ordering); offline replay re-sends a single-field
  PATCH safely.
- **Web (`HomePage.test.tsx`):** the detail Project row renders the current
  project, the picker lists projects + "No project", picking moves the task off
  Home's loose list, and clearing to loose returns it.
- **Mobile:** unit tests for the picker sheet and the reworked `useTaskDetail`,
  then **Pixel 7 device verification** (per AGENTS.md, mandatory for mobile): open
  a throwaway loose task's detail, move it into a throwaway project (confirm it
  leaves Home and appears parked on that project), move it back to loose, and
  confirm offline replay. Create and delete your own throwaway entities — never
  mutate the user's real production data. Pure-JS reworks hot-reload over the dev
  client; no EAS build needed unless a brand-new native surface is introduced.

## Documentation

- `docs/entities/task.md`: add **Move to project** to the Vocabulary/Behavior
  (store verb `setProject`, RPC `setTaskProject`, PATCH field `projectId`, log
  `task_moved`), and state the `takenOnAt`-cleared-on-move-in rule and that it
  replaces the removed clarify/process step. Single source of truth — do not
  restate the rule elsewhere.
- `docs/todo-app.md`: reconcile the tracking/build-order note (plan 2 shipped).
- **Changelog (same change, user-observable):** a dated bullet in
  `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md` — "Move a
  task into a project (or back to loose) from its detail." Load the `changelog`
  skill before editing.

## Skills to use

- `deep-modules` — `projectId` extends the deep PATCH verb rather than adding a
  parallel endpoint; keep the seam single.
- `tdd` — red-green at the store, route, and collection interfaces before the UI.
- `changelog` — before touching either CHANGELOG.
- `git-commit` — when committing. `open-pr` — one PR for this plan.

## Acceptance criteria

- A task can be moved into a project and back to loose from its detail screen: on
  mobile from both Home and Upcoming (shared `useTaskDetail`), on web from Home
  (web Upcoming is out of scope for v1 — see the web asymmetry decision).
- Moving into a project clears `takenOnAt`; the task then obeys the project's
  curation gate (leaves Home unless taken-on + active) and appears on the project
  screen.
- Moving back to loose leaves the task always-visible on Home.
- `sortKey` is preserved across the move (no reorder side effect).
- `PATCH /api/tasks/{id}` accepts `projectId` (uuid or null); malformed id → 400,
  unknown id → 404, empty body still → 400.
- Offline-safe (single-field replayed PATCH); Pixel 7 device-verified on mobile.
- `pnpm -F @zero/agent-api test/lint/typecheck`, agent-core, and web suites pass.
