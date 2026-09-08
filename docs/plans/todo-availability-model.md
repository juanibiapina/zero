# Todo app: the availability model (Tasks, Projects, Waiting, Refine)

Break the "what shows up" vision into small vertical slices. Each slice is one
shippable increment across data + API + `@zero/agent-core` + both surfaces
(web first, then mobile), the established pattern for this app.

A clickable prototype of the whole target model lives at
`docs/prototypes/todo-model.html` (throwaway, no persistence). Read it to feel
the end state; this plan turns it into product code.

## Goal

Make the daily list a **computed view**, not a hand-kept one. A task shows up on
Home only when it is open, its project is `active` (or it is loose), and the user
has taken it on. Projects move themselves between `active`/`next`/`waiting` from
that state and from explicit waiting conditions. A capture becomes tasks/projects
through an in-app **Refine** session. The whole thing works by hand today; the AI
later accelerates the free-text cases without being required.

## Current state (what already exists)

- **Capture** — shipped. One list (Home is currently a single Captures list),
  `showUpDate` + fractional `sortKey`, postpone, an Upcoming section, an
  edit-only detail sheet. Verbs: add / process / edit / postpone / reorder.
- **Task** — built but **parked**, unreferenced by any UI. `tasks` table +
  `DbTaskStore` (`add`/`list`/`complete`), `/api/tasks`, `@zero/agent-core`
  `createTasksApi` + `dueToday`/`localToday`. Shape: `id, text, showUpDate,
  createdAt, completedAt`. No `projectId`, no `sourceCaptureId`, no selection.
- **Project** — slice A complete. `projects` table + `DbProjectStore`
  (`add`/`list`/`setStatus`/`edit`/`delete`), `/api/projects`, `createProjectsApi`,
  a status-grouped list, and a detail bottom sheet (emoji, title, notes, a manual
  five-status picker, delete). Status is **manually set** today. Shape: `id,
  title, icon, description, status, createdAt`.
- **Chrome** — bottom tabs (mobile) / sidebar (web) with Captures, Projects,
  Upcoming. Detail sheet is a shared primitive (web `@radix-ui/react-dialog`;
  mobile `@expo/ui` `BottomSheet`).
- **Shared plumbing** — the collection factory
  (`packages/agent-core/src/collection/base.ts`) gives every entity optimistic
  local-first sync, an offline outbox, client-minted ids, and `add`/`update`/
  `delete` verb kinds. Pure list/section helpers live in `@zero/agent-core`; React
  hooks live per-app in `screen-hooks` (agent-core stays React-free).

## Key decisions (pin these before building)

1. **Status is derived on the client; the column stays.** Keep the stored
   five-value `status`. The client computes a **display status** for a project
   from its tasks and conditions: if stored status is `backlog` or `done`, use it;
   otherwise it is "in play" and the display status is `waiting` (has an
   unresolved condition) → `active` (has a taken-on open task) → `next`. `setStatus`
   is kept only for the manual moves: put-in-play (writes `next`), move-to-backlog,
   mark-done. No status migration. This keeps the server storage-only and puts the
   rule in one pure, tested module. Alternative considered: collapse the column to
   `{inPlay, backlog, done}` — rejected for now (needs a migration and rewrites the
   existing grouped list for no added capability).

2. **Selection is a nullable `takenOnAt` timestamp** on Task (`null` = parked).
   A timestamp over a boolean so the top list can order by when it was taken on and
   an undo is auditable. This is the curation lever ("take on now / park").

3. **Availability is one deep module.** A pure `homeTasks(tasks, projects,
   conditions)` in `@zero/agent-core` is the single interface for "what shows up on
   top". It deepens slice by slice (project-active gate, then taken-on gate). Its
   dependencies are in-process (plain arrays), so it is tested directly through its
   interface — no adapter. Same for `projectDisplayStatus(project, tasks,
   conditions)`.

4. **Waiting conditions: free-text is persisted-resolved; structured kinds are
   derived-satisfied.** A `task-done` or `project-status` condition is *satisfied*
   by a pure client check against the other collections (no write). A `free-text`
   condition needs an explicit resolve (persists `resolvedAt`). "Unresolved" =
   open and not currently satisfied. This mirrors the free-text principle: code
   settles the structured cases, a human/AI settles the prose.

5. **`showUpDate` stops gating Home.** Availability replaces the date gate. Task
   keeps the column (reschedule is a separate later concern), but the Home selector
   ignores it. Captures keep `showUpDate` for postpone/Upcoming unchanged (Option B
   from the design conversation: dates only move a capture within the bottom
   inbox).

6. **Home is two regions in the Captures screen.** Top = tasks (availability), bottom
   = the existing Captures list. This reverses the "one Captures list" shape
   deliberately. The "+" quick-add stays capture-default with a task mode.

## Slices

Each slice ships web first, then mobile (two steps), and adds a user-facing
changelog entry: mobile → `apps/agent-mobile/CHANGELOG.md`, web →
`apps/agent-web/CHANGELOG.md`. First on-device use of any new native / `@expo/ui`
control needs a fresh EAS dev build. Keep `docs/entities/*` and `docs/todo-app.md`
current as each lands.

### Slice 1 — The merged Home: bring the parked Task back

**Completes a current flow.** Task is fully built server-side (table, store, API,
collection) but has no UI. This slice re-surfaces it, nothing new in the data
model.

**Outcome:** Home shows a top **Tasks** region above the existing Captures list.
The top lists open tasks; completing one removes it. The "+" quick-add keeps
capture-default and gains a task mode.

- **Data / API / store:** none new — use `DbTaskStore`/`/api/tasks`/`createTasksApi`
  as they are (`add` dates today, `list` = open tasks, `complete`).
- **agent-core:** `homeTasks(tasks)` — open tasks, ordered (no project gate yet;
  every task is loose today). This is the availability seam; it deepens in later
  slices. Ignore `showUpDate` for the gate (see decision 5).
- **UI:** the Captures screen renders two regions (top tasks, bottom captures). The
  "+" adder gains a **Task** mode (capture stays default). Complete a task from the
  top. Home loads the tasks collection alongside captures.
- **Tests:** `homeTasks` (open shown, completed excluded, order); a web page test
  for the two regions and the task quick-add.
- **Acceptance:** a task added on Home appears on top, completes, and syncs; the
  Captures list still works below; offline add replays once.

### Slice 2 — A Task belongs to a Project; groom on the project screen

**New feature.** The first data-model addition.

**Outcome:** you can add tasks under a project and see/add/complete them in the
project's detail sheet.

- **Data:** add nullable `projectId` to `tasks` (migration). `DbTaskStore.add`
  accepts `projectId`; add `listForProject(projectId)` (open tasks of one project,
  oldest-first).
- **API:** `POST /api/tasks` accepts optional `projectId`; add
  `GET /api/projects/{id}/tasks` → `{ tasks }`. Keep `POST /api/tasks/{id}/complete`.
- **agent-core:** `Task` gains `projectId: string | null`. `createTasksApi` gains
  `addTask({ projectId })` and a `tasksForProject(projectId)` selector.
- **UI:** the project detail sheet renders the project's open tasks (text +
  complete) and an inline "Add a task to this project…" field. A task added on Home
  can also carry a picked project.
- **Tests:** store (`add` with/without project, `listForProject`), route contract,
  agent-core selector.
- **Acceptance:** a task created in a project's sheet persists there, completes, and
  syncs; offline add replays once.

### Slice 3 — Project-active gate on Home (availability v1)

**New feature.** The "active project surfaces its tasks" behavior, using the
existing manual project status.

**Outcome:** the Home top region shows open tasks that are loose OR whose project
is `active`; tasks in non-active projects stay hidden.

- **agent-core:** `homeTasks(tasks, projects)` — open AND (`projectId == null` OR
  project status `active`). Deepens the slice-1 seam.
- **UI:** Home loads the projects collection too; the top region filters through
  the deepened `homeTasks`.
- **Tests:** `homeTasks` gate (loose shows; active-project shows; non-active
  hidden).
- **Acceptance:** manually activating a project surfaces its open tasks on Home;
  deactivating hides them; loose tasks always show.

### Slice 4 — Curation: take on / park a task

**New feature.**

**Outcome:** you choose which eligible tasks show on top; the rest stay parked.

- **Data:** add nullable `takenOnAt` to `tasks` (migration).
- **API:** `PATCH /api/tasks/{id} { takenOnAt }` (take on = now; park = null),
  idempotent on id.
- **agent-core:** `Task.takenOnAt: string | null`; `createTasksApi` verbs
  `takeOn`/`park`; `homeTasks` now also requires `takenOnAt != null`.
- **UI:** a star (take-on toggle) on tasks in the project sheet and on Home. Tasks
  added from a **project screen** default **parked** (groom = collect then take on);
  a task added from the **Home "+"** defaults **taken on**.
- **Tests:** `homeTasks` taken-on gate; verb replay.
- **Acceptance:** starring a task surfaces it; un-starring parks it; new
  project-screen tasks stay parked until starred.

### Slice 5 — Derived project status (active / next)

**New feature.**

**Outcome:** a project moves itself between `active` and `next` from its taken-on
tasks; `next` means "come groom / take on more". Backlog/done stay manual.

- **agent-core:** `projectDisplayStatus(project, tasks)` — `backlog`/`done` from the
  stored value; else `active` if it has a taken-on open task, else `next`.
- **UI:** the project list groups by **display** status. The detail sheet's status
  control becomes three manual moves — **Put in play** (writes `next`), **Move to
  backlog**, **Mark done** — dropping the manual active/next (and, until slice 6,
  waiting) picks. Completing the last taken-on task drops the project to `next`; its
  tasks stay reachable in the sheet for re-grooming regardless of display status.
- **Tests:** `projectDisplayStatus` truth table; grouping over derived status.
- **Acceptance:** finishing the last taken-on task moves a project `active → next`
  with no manual step; taking one on moves it back.

### Slice 6 — Waiting conditions (the new entity)

**Outcome:** a project can carry one or more waiting conditions; any unresolved one
makes it `waiting`. Structured kinds clear themselves in code; free-text is
resolved by hand (AI later).

- **Data:** new `waiting_conditions` table: `id, projectId, kind
  ('free-text'|'task-done'|'project-status'), text, refId, targetStatus,
  resolvedAt, createdAt` (migration). New `DbWaitingConditionStore`
  (`add`/`listForProject`/`resolve`/`delete`), a sibling per-entity store.
- **API:** `POST /api/projects/{id}/waits`, `GET /api/projects/{id}/waits`,
  `POST /api/waits/{id}/resolve`, `DELETE /api/waits/{id}`. (Or nest all under the
  project; pick one and document it.)
- **agent-core:** `WaitingCondition` type + `createWaitsApi` collection.
  `conditionSatisfied(cond, tasks, projects)` (pure): free-text → satisfied iff
  `resolvedAt` set; task-done → referenced task completed; project-status →
  referenced project reached target. `unresolvedConditions(project, ...)` filters
  to open-and-unsatisfied. `projectDisplayStatus` returns `waiting` when an
  unresolved condition exists **and nothing is taken on**; a taken-on open task
  overrides waiting and keeps the project `active` (completing it reverts to
  `waiting`, not `next`).
- **UI:** the detail sheet lists conditions and gains **+ Waiting condition**
  (three kinds; free-text default) and a **Resolve** action on free-text ones
  (plus an "AI resolve" affordance stub — same action, labeled). This replaces the
  manual `waiting` status pick.
- **Tests:** `conditionSatisfied` per kind; `projectDisplayStatus` with conditions;
  store + route contract.
- **Acceptance:** adding a condition puts the project in `waiting` (when nothing
  is taken on) and hides its tasks from Home; taking a task on overrides waiting
  and brings the project (and task) back to `active`, and completing that task
  returns it to `waiting`; resolving the last condition returns it to
  `active`/`next`; a `task-done` condition clears itself when the referenced task
  completes.

### Slice 7 — Complete-in-place linger + "+ Waiting condition" shortcut

**Outcome:** completing a task on Home leaves it in place ~5s with **Undo** and
**+ Waiting condition**, the fast path to record what the project now waits on.

- **UI only:** reuse the existing `useUndoableLeave` timer. The lingering row keeps
  its slot, shows Undo + "+ Waiting condition" (opens slice-6's editor on the
  task's project, free-text default); loose tasks show no condition action. After
  the window it settles; the durable path stays the project sheet.
- **Tests:** hook/interaction test where feasible.
- **Acceptance:** completing "Mail the letter" and clicking "+ Waiting condition"
  creates the condition on its project and the project goes `waiting`.

### Slice 8 — Refine a capture into tasks/projects

**Outcome:** tapping a capture starts a Refine session; anything you create during
it links back to the capture; **Done** consumes the capture. One capture can fan
out to many tasks/projects.

- **Data:** add nullable `sourceCaptureId` to `tasks` and `projects` (migration).
- **API:** `POST /api/tasks` and `POST /api/projects` accept optional
  `sourceCaptureId`. Capture already has `process` (sets `processedAt`).
- **agent-core:** thread `sourceCaptureId` through both create verbs.
- **UI:** a client-side refine mode (a session banner spanning Home); capture rows
  gain **Refine**. While active, every create (Home "+", project add, project
  screen) is tagged with the capture id; **Done** processes the capture (drains the
  inbox), **Cancel** leaves it. One session at a time.
- **Tests:** create carries `sourceCaptureId`; capture processed on Done.
- **Acceptance:** refining one capture into a project + two tasks links all three
  to it and removes the capture from the inbox; offline-safe.

## Ordering and independence

**Sequencing principle: complete current flows first, then add new features in
dependency order — not highest-value-first.** So the parked Task returns to the UI
(slice 1) before any new data-model work, and each new feature lands only once the
one it builds on exists.

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`.

- **Slice 1** completes a current flow (Task has server code but no UI). Uses
  nothing new.
- **Slice 2** (membership) is the first new feature; needs slice 1's Home to have
  somewhere for tasks to live and slice-A Projects (already shipped).
- **Slice 3** (active gate) needs 2 (a task must know its project).
- **Slice 4** (curation) needs 3 (there is a gated top to curate).
- **Slice 5** (derived active/next) needs 4 (derivation reads taken-on).
- **Slice 6** (waiting conditions) needs 5 (its `waiting` display extends
  `projectDisplayStatus`).
- **Slice 7** (linger shortcut) needs 6 (it creates a condition).
- **Slice 8** (Refine) needs only 2 (creatable project tasks); it lands last as the
  capture→task/project feature, after the availability model is complete. It is
  deliberately not pulled earlier despite its value.

## Version control and delivery

- Do all of this work on a **branch**, not `main`. One branch for the effort;
  push it as you go.
- **Commit when it makes sense** — do not batch everything into one commit. The
  natural commit points are within and at the end of each slice, whenever a piece
  is **tested and working** (green build/tests). A vertical slice is usually two
  commits (web, then mobile), and small internal steps (a new store verb with its
  test, a pure helper with its truth table) are fine to commit on their own once
  green.
- Never commit a red or half-wired state; each commit should build and pass its
  tests.
- At the **end**, open a **pull request** for the branch (use the `open-pr`
  skill). Do not merge to `main` mid-effort — pushing to `main` auto-deploys, and
  a PR keeps the whole model reviewable as one story even though it landed in
  slices.
- Follow the `git-commit` skill for each commit and the changelog rule (a
  user-facing bullet in the same commit as the code).

## Deep-module notes

- `homeTasks` and `projectDisplayStatus` are the two deep modules. Small
  interface (arrays in, list/enum out), all the availability and status logic
  behind them, in-process dependencies → tested directly, no adapter. The deletion
  test passes: delete them and the same conditionals reappear scattered across web
  and mobile render code.
- Server stores stay thin domain-verb stores over do-orm (local-substitutable
  SQLite in tests). Do not push derivation server-side; the client holds all
  collections local-first and is the natural place for the pure rules.

## Test strategy

- Pure helpers (`homeTasks`, `projectDisplayStatus`, `conditionSatisfied`,
  `unresolvedConditions`) — unit tests in `@zero/agent-core`, the interface as the
  test surface; cover each gate and the status truth table.
- Stores — do-orm SQLite tests per new verb (`listForProject`, `takeOn`/`park`,
  the waits store), including idempotent replay.
- Routes — request/response contract tests mirroring existing `*.test.ts`.
- Web — a page test per new screen behavior (Vitest + Testing Library, already set
  up for `apps/agent-web`).
- Mobile — unit/typecheck via Turbo; on-device Maestro for the native controls
  (needs an EAS dev build for first native use).

## Documentation strategy

- Update `docs/entities/task.md` (un-park it; add `projectId`, `takenOnAt`,
  `sourceCaptureId`, and the availability role) and `docs/entities/project.md`
  (derived status; waiting conditions; grooming) as those slices land.
- Add `docs/entities/waiting-condition.md` in slice 6 (source of truth for the new
  entity).
- Keep `docs/todo-app.md` tracking + wiki current; keep `docs/storage.md` current
  when the waits collection adds a pattern.
- Each user-facing slice adds a changelog bullet in the same change.

## Skills to use

- `tdd` — for the pure helpers and stores (write the truth tables first).
- `deep-modules` / `vocabulary` — when shaping `homeTasks` and
  `projectDisplayStatus` and their seams.
- `testing` — deciding what to test through each interface, what to fake.
- `changelog` — the per-slice user-facing entry.
- `git-commit` — each commit at a green, tested point (web and mobile as separate
  commits per slice); commit often, never a red state.
- `open-pr` — open the pull request at the end of the branch.
- `impeccable` — the Home two-region layout and the refine bar polish.

## Risks

- **Status derivation vs the existing manual sheet (slice 5)** is the riskiest
  change; it rewrites how the project list groups and how the sheet edits status.
  Ship 1–4 first so tasks/membership/selection exist before derivation flips on.
- **Home reshape (slice 1)** reverses the one-list decision; confirm the two-region
  layout feels right on a phone before mobile ships (the prototype is the reference).
- **Waiting-condition resolution split (derived vs persisted)** must be one
  documented rule, or "why is this still waiting" gets confusing. `conditionSatisfied`
  is the single source of that truth.
- **Mobile native-control lag** — every slice touching a new `@expo/ui` control
  needs an EAS dev build before Maestro can verify it.
