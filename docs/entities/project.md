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

## Status: building (slices A1 + A2 shipped)

Project is being built in vertical slices (plan: `docs/plans/todo-project-entity.md`).

- **A1 (shipped):** create a Project by name and see a flat list, on web
  (`/projects`) and mobile (a Projects tab). Persists and syncs; mobile create
  works offline.
- **A2 (shipped):** the five-status model is real — the list is grouped into
  Active / Next / Waiting / Backlog sections (counts, collapse, hide-empty), a
  detail bottom sheet holds a Status group, and setting `done` removes a project
  from the working list with an inline Undo (~5s). Ships on web and mobile,
  offline-safe.
- **A3 (next):** enrich in the sheet — emoji icon picker, editable title,
  description.

The icon and description fields already exist in the data (with defaults) so A3
needs no migration; only its UI is deferred.

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
- **List** — the working set: every non-`done` project, oldest first. The client
  groups them into status sections (`projectsByStatus`).
- **Set status** — move a Project to any of the five states. Setting `done` is
  terminal and drops it from the working list. One `setStatus` verb carries every
  transition.

## Interactions (per system)

- **UI** — web `/projects` (`apps/agent-web`, a `SideNav` entry) and the mobile
  Projects tab (`apps/agent-mobile`, a `NativeTabs` trigger). A name-only
  quick-add (with persistent helper text teaching outcome-based naming — helper
  text, not the placeholder) over a status-grouped list: collapsible Active /
  Next / Waiting / Backlog sections with counts, empty sections hidden, Backlog
  collapsed when large. A row is a single tap target that opens a **detail bottom
  sheet** (web: `@radix-ui/react-dialog`; mobile: the universal `@expo/ui`
  `BottomSheet`) holding a **Status group** — the five states, current one marked.
  Setting `done` leaves the row briefly struck-through with an inline **Undo**
  (~5s) before it leaves the list. The sheet is a generic, entity-agnostic
  primitive (`components/ui/sheet.tsx`), shared with the Captures detail sheet.
- **Storage** — the server domain store is `DbProjectStore` (domain methods
  `add` / `list` / `setStatus`), a sibling of `DbCaptureStore` / `DbTaskStore`;
  the duplication is deliberate and removed by a Rule-of-Three extraction after
  A3. See `docs/storage.md`.
- **API** — per-user isolated:
  - `GET /api/projects` → `{ projects }`, the non-`done` working set, oldest-first.
  - `POST /api/projects { id, title, icon?, description?, status? }` →
    `201 { project }`; the client normally sends only `id` + `title` and the
    server fills the defaults. `400` on empty title, a non-UUID id, or an unknown
    status.
  - `PATCH /api/projects/{id} { status }` → `200 { project }`; `400` (no fields /
    unknown status) / `404`. Setting `done` drops the row from the list.
  - Logs `project_added` and `project_status_changed`.
- **Data layer** — a TanStack DB collection (`createProjectsApi` in
  `@zero/agent-core`), a sibling of the Task layer: in-memory fallback plus
  durable persisted offline mode with an outbox (`addProject` /
  `setProjectStatus` replay offline), and pure `projectsReconcileWrites` /
  `projectsByStatus` helpers. See `docs/storage.md`.
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

- **Enrich (A3)** — emoji icon picker, editable title, description, all in the
  detail sheet.
- **Task → Project (slice B)** — a Task belongs to a Project (adds `projectId` on
  `tasks`); the sheet grows the project's Task list.
- **AI conversion** — swipe a Capture, propose a Project, confirm (later slices of
  `docs/plans/todo-capture-to-project-ai.md`).
- **Rule-of-Three extraction** — after A3, extract the shared offline collection
  factory, the `*View` count-gate, and the id/createdAt/dedupe conventions from
  Capture/Task/Project; never the domain verbs.
