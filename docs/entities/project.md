# Project

The third entity of the todo app (after Capture and Task), and the first
container: a named, outcome-oriented thing you intend to reach, with a status.
Distinct from a Capture (a raw, untyped thought) and a Task (a single dated
next-action). A Project groups work toward an outcome; Tasks will later belong to
one.

Each entity documents how it plugs into every system of the app (the
Minecraft-block philosophy). This file is the source of truth for Project; keep
it current as the entity grows.

## Why Project is its own entity

A Project answers "what outcome am I working toward", which neither Capture nor
Task expresses. It has its own producer set (the user by hand now; the AI
converting a Capture later) and its own lifecycle verb — a status that moves
across `active` / `next` / `waiting` / `backlog` / `done` — none of which fits on
Capture or Task. So Project earns entity status with its own `addProject` verb
and `projects` table, a sibling of `DbCaptureStore` / `DbTaskStore`.

The name is `Project`.

## Status: building (slice A1 shipped)

Project is being built in vertical slices (plan: `docs/plans/todo-project-entity.md`).

- **A1 (shipped):** create a Project by name and see a flat list, on web
  (`/projects`) and mobile (a Projects tab). Persists and syncs; mobile create
  works offline. No status UI, no detail sheet, no AI.
- **A2 (next):** the five-status model becomes real — grouped sections, a detail
  bottom sheet with a Status group, `done` + inline Undo.
- **A3:** enrich in the sheet — emoji icon picker, editable title, description.

The status, icon, and description fields already exist in the data (with
defaults) so A2/A3 need no migration; only their UI is deferred.

## What it is

A named container with a status: `title`, an `icon` (emoji), an optional
`description`, and a `status`. At creation only the title is asked for; the rest
take defaults and are enriched later.

## Vocabulary

- **Project** — the item (table `projects`, type `Project`).
- **Outcome name** — the `title`, phrased as a measurable, observable result
  ("Run a 5K under 30 min", "Have a baby"), not a vague area ("Fitness"). The
  create field teaches this through helper text.
- **Status** — one of `active` (being worked now), `next` (on deck), `waiting`
  (blocked on someone/something), `backlog` (someday pile), `done` (finished).
  `done` is terminal. Defaults to `next` at creation.
- **Icon** — a single emoji, defaulting to 📁, changed later from the detail
  sheet.

## Data shape

`projects` table in the per-user `UserDO` (SQLite). Client-facing `Project`:

- `id` — string id, a UUID the **client mints** and the server persists verbatim
  as the primary key (stable end to end, so the optimistic row never swaps keys,
  and it is the dedupe key: a replayed add re-sends the same id)
- `title` — the outcome name (required, non-empty)
- `icon` — a single emoji; defaults to 📁
- `description` — nullable free text (a sentence of intent); null when unset
- `status` — `active` | `next` | `waiting` | `backlog` | `done`; defaults to
  `next`
- `createdAt` — ISO timestamp

The partial index `projects_open` on `("createdAt")` `WHERE "status" != 'done'`
serves the working-list query (mirrors `tasks_open`; keeps a large `done` pile
out of the index). In A1 every row is `next`, so nothing is excluded yet.

### Deferred columns

`projectId` on the `tasks` table (Task membership) is deliberately **not** a
column yet. It arrives with the Task-under-Project slice (slice B), after A2/A3.
No `sortKey` (manual reorder), `color`, year/time-horizon, or category columns:
no speculative columns before their behavior is designed.

## Behavior

- **Add** a Project by name. The client sends only `id` + `title`; the server
  fills the defaults (icon 📁, description null, status `next`). New projects
  land visible in the working set. Creating is name-only and fast, like a
  Capture.
- **List** — all projects, oldest first. A1 returns every row (all `next`); once
  statuses can change (A2) the list scopes to the non-`done` working set and
  groups by status.

## Interactions (per system)

- **UI** — web `/projects` (`apps/agent-web`, a `SideNav` entry) and the mobile
  Projects tab (`apps/agent-mobile`, a `NativeTabs` trigger). Both are a name-only
  quick-add over a flat list of rows (emoji icon + title). The create field
  carries persistent helper text teaching outcome-based naming — helper text, not
  the placeholder. Rows are display-only in A1; tapping to open a detail sheet is
  A2.
- **Storage** — the server domain store is `DbProjectStore` (domain methods
  `add` / `list`), a sibling of `DbCaptureStore` / `DbTaskStore`; the duplication
  is deliberate and removed by a Rule-of-Three extraction after A3. See
  `docs/storage.md`.
- **API** — per-user isolated:
  - `GET /api/projects` → `{ projects }`, oldest-first.
  - `POST /api/projects { id, title, icon?, description?, status? }` →
    `201 { project }`; the client normally sends only `id` + `title` and the
    server fills the defaults. `400` on empty title, a non-UUID id, or an unknown
    status.
  - Logs `project_added`.
- **Data layer** — a TanStack DB collection (`createProjectsApi` in
  `@zero/agent-core`), a sibling of the Task layer: in-memory fallback plus
  durable persisted offline mode with an outbox, and a pure
  `projectsReconcileWrites` diff. See `docs/storage.md`.
- **Other entities** — none wired yet. Task membership (`projectId` on `tasks`)
  is slice B; the AI Capture → Project conversion is a later slice.

## Shared view rule

The Projects list region gates on the row count, not the collection's
`isLoading`, via the shared `projectsView` helper in `@zero/agent-core` (same rule
as `todayView` / `capturesView`: rows whenever present; the spinner only when
empty and loading). The persisted collection hydrates the local snapshot before
the network sync marks ready, so gating on `isLoading` would hide a hydrated
snapshot behind a spinner.

## Next

- **Status model in the UI (A2)** — grouped Active / Next / Waiting / Backlog
  sections with counts and collapse; a detail bottom sheet with a Status group;
  `done` removes a project from the working list with an inline Undo.
- **Enrich (A3)** — emoji icon picker, editable title, description, all in the
  detail sheet.
- **Task → Project (slice B)** — a Task belongs to a Project (adds `projectId` on
  `tasks`); the sheet grows the project's Task list.
- **AI conversion** — swipe a Capture, propose a Project, confirm (later slices of
  `docs/plans/todo-capture-to-project-ai.md`).
- **Rule-of-Three extraction** — after A3, extract the shared offline collection
  factory, the `*View` count-gate, and the id/createdAt/dedupe conventions from
  Capture/Task/Project; never the domain verbs.
