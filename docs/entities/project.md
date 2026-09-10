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

## Status: slice A complete (A1 + A2 + A3 shipped)

Project was built in vertical slices (plan: `docs/plans/todo-project-entity.md`).

- **A1 (shipped):** create a Project by name and see a flat list, on web
  (`/projects`) and mobile (a Projects tab). Persists and syncs; mobile create
  works offline.
- **A2 (shipped):** the five-status model is real — the list is grouped into
  Active / Next / Waiting / Backlog sections (counts, collapse, hide-empty), a
  detail bottom sheet holds a Status group, and setting `done` removes a project
  from the working list with an inline Undo (~5s). Ships on web and mobile,
  offline-safe.
- **A3 (shipped):** enrich in the sheet — a full emoji icon picker (web
  `frimousse`, mobile `rn-emoji-keyboard`; any standard emoji), an editable title,
  and an editable description. Edits commit on blur/submit (the icon on tap), keep
  the sheet open, persist, and sync offline. Ships on web and mobile.
- **Delete (shipped, post-A3):** permanently remove a Project from its detail
  sheet, distinct from `done`. A destructive button drops the row behind the same
  ~5s Undo as `done`, then hard-removes it (`DELETE /api/projects/{id}`, 204,
  idempotent). Offline-safe on both surfaces. Added the shared collection
  factory's first `delete` verb kind (`docs/storage.md`).

Slice A (the hand-managed Project entity, no AI, no Task membership) is complete.
The icon and description columns existed from A1's migration, so A3 needed none.
The Rule-of-Three extraction of the shared client plumbing followed
(`docs/plans/todo-rule-of-three-extraction.md`); the next tracked change is
slice B (Task-under-Project).

## What it is

A named container with a status: `title`, an `icon` (emoji), an optional
`description`, and a `status`. At creation only the title is asked for; the rest
take defaults and are enriched later on the project's own screen (icon picker,
editable title and notes).

## Derived status (slice 5)

The stored `status` column is only the deliberate parking value: `backlog` and
`done` are set by hand. The three in-play states are **derived on the client**
from the project's tasks by `projectDisplayStatus` (in `@zero/agent-core`): a
project shows as `active` while it has a taken-on, open task, else `next` ("come
groom / take on more"). An open waiting condition shows the project as `waiting`,
but **a taken-on open task overrides waiting** — starring a task pulls a waiting
project back to `active`; completing that task returns it to `waiting` (the
condition is still open), not `next`. The list groups by this derived status (`projectsByStatus`
takes a `statusOf` mapper). A waiting project also shows **how long it has been
waiting** — the elapsed time since its oldest unresolved condition was created
(`waitingSince` + `waitingLabel`, a readable phrase like "3 days") — as a muted
trailing badge on its row, and the Waiting section is ordered **longest-waiting
first** (`projectsByStatus` takes an optional `sortKeyOf`; the list passes
`waitingSince(p) ?? p.createdAt`, so only the Waiting section reorders while the
others keep their created-at order). The project screen's actions menu offers
three manual moves — **Put in play** (writes `next`), **Move to backlog**, **Mark done** — not
a five-way picker. No status migration: the column stays; the display is
computed. See `docs/plans/todo-availability-model.md`.

## Vocabulary

- **Project** — the item (table `projects`, type `Project`).
- **Outcome name** — the `title`, phrased as a measurable, observable result
  ("Run a 5K under 30 min", "Have a baby"), not a vague area ("Fitness"). The
  create field teaches this through helper text.
- **Status** — one of `active` (being worked now), `next` (on deck), `waiting`
  (blocked on someone/something), `backlog` (someday pile), `done` (finished).
  `done` is terminal. Defaults to `next` at creation. **`active`/`next` are now
  derived, not hand-set** (see Derived status).
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
- **Edit** — change a Project's `title`, `icon`, or `description` (only the given
  fields; the description may be cleared to null). One `edit` verb, separate from
  `setStatus` (status has terminal semantics). Idempotent on the id, so an
  offline edit replays safely.
- **Delete** — permanently remove a Project. Distinct from `done`: `done` keeps
  the row (out of the working list) while delete hard-removes it. Idempotent on
  the id (a replayed delete of an already-gone Project is a no-op), so an offline
  delete replays safely. Destructive with no server-side undo, so the UI holds a
  brief client-side Undo window before it commits.

## Interactions (per system)

- **UI** — web `/projects` (`apps/agent-web`, a `SideNav` entry) and the mobile
  Projects tab (`apps/agent-mobile`, a `NativeTabs` trigger). A name-only
  quick-add (with persistent helper text teaching outcome-based naming — helper
  text, not the placeholder) over a status-grouped list: collapsible Active /
  Next / Waiting / Backlog sections with counts, empty sections hidden, Backlog
  collapsed when large. A row is a single tap target that **navigates to the
  project's own screen** — a destination, not a bottom sheet (web: a
  `/projects/:id` route within the app shell; mobile: a screen pushed within the
  Projects tab, keeping the tab bar, with native Back). A project is a place you
  work, and the bottom-sheet guidance is explicit that a transient sheet is for
  short interactions, not a surface you dwell on and navigate within; a pushed
  React Native screen also avoids hosting raw RN rows inside an `@expo/ui` native
  tree (the bug that broke the old mobile detail sheet's task/waiting rows). See
  `docs/plans/todo-project-detail-rework.md`. The screen leads with the **work**:
  a compact header (a de-emphasized emoji icon that opens its picker on tap, the
  **title** as an editable heading, a read-only **derived-status pill**, and a
  "⋯" **actions menu** with the status moves and **Delete project**), then the
  project's **description** — its statement of intent, an always-visible editable
  field directly under the title — then the project's **tasks** (complete,
  take-on/park; a task is added from a plus button (a FAB) that opens a
  **task-only** quick-add bar docked to the keyboard — no capture mode, so
  captures are not selectable here), then its **waiting conditions** (add
  revealed on "+"). Field edits commit on blur/submit (the icon on tap). Choosing **Mark
  done** or **Delete project** returns to the list and leaves the row briefly
  struck-through with an inline **Undo** (~5s) before it leaves (delete then
  hard-removes it server-side). Sheets/menus still serve the short
  sub-interactions here (the icon picker and the status/delete actions on mobile
  are each a pure `@expo/ui` sheet); the **Captures** detail — a single leaf
  item — is still a bottom sheet (`components/ui/sheet.tsx`).
- **Storage** — the server domain store is `DbProjectStore` (domain methods
  `add` / `list` / `setStatus` / `edit` / `delete`), a per-entity store like
  `DbCaptureStore` / `DbTaskStore` (do-orm is the shared layer; a store holds
  only domain verbs). See `docs/storage.md`.
- **API** — per-user isolated:
  - `GET /api/projects` → `{ projects }`, the non-`done` working set, oldest-first.
  - `POST /api/projects { id, title, icon?, description?, status? }` →
    `201 { project }`; the client normally sends only `id` + `title` and the
    server fills the defaults. `400` on empty title, a non-UUID id, or an unknown
    status.
  - `PATCH /api/projects/{id} { status?, title?, icon?, description? }` →
    `200 { project }`; `400` (no fields / empty title or icon / unknown status) /
    `404`. Carries both the status transition (`done` drops the row from the
    list) and the edit fields; an edit sends only the changed field.
  - `DELETE /api/projects/{id}` → `204` (empty body). Idempotent: returns `204`
    whether or not the row existed, so a replayed offline delete never makes the
    outbox throw and retry forever (deliberately no `404`, unlike `PATCH`).
  - `POST /api/projects/icon-suggestions { title, description? }` →
    `200 { icons }`, single-emoji suggestions; `400` on empty title. **Stateless**
    on purpose: it reads/writes no project row (it is the first todo-app server
    LLM call, not a collection verb), so both the create-time pre-warm and the
    picker's fetch-on-open call it. A soft miss (the model returns nothing usable)
    is still `200 { icons: [] }`.
  - Logs `project_added`, `project_status_changed`, `project_edited`,
    `project_deleted`, and `project_icon_suggested` (with the count).
- **Data layer** — a TanStack DB collection (`createProjectsApi` in
  `@zero/agent-core`) built on the shared collection factory: a verb table
  (`addProject` / `setProjectStatus` / `editProject` / `deleteProject`, also the
  offline outbox names) over the factory's in-memory fallback and durable
  persisted offline mode, plus the pure `projectsByStatus` helper. `setStatus`
  and `edit` share one `collection.update`, told apart by the changed field set;
  a row whose status becomes `done` leaves the collection at once. `deleteProject`
  is the shared factory's `delete` verb kind — it optimistically drops the row and
  issues the `DELETE`, rolling back on failure. See `docs/storage.md`.
- **AI icon suggestion** — the first AI integration of the todo app. When a
  project is created (name-only, so from the title alone), the app fires a
  background request to the stateless `icon-suggestions` endpoint and caches the
  result **on the device** (not synced; no server row). When the icon picker
  opens, a "Suggested" row shows the cached emoji instantly (or "Loading suggested
  icons…" if still in flight); tapping one applies it through the existing `edit`
  path. A cache miss (a different device, an eviction, an offline creation)
  fetches on open; a Refresh control recomputes after the title/description
  changes. A failed or empty suggestion degrades silently to the full manual
  picker below — it is logged, never surfaced as an error. The server call runs a
  one-shot, tool-less model request (agent label `icon_suggest`, `low` effort);
  the pure cache-staleness check is shared in `@zero/agent-core`, the persistence
  and fetch are per surface. See `docs/plans/todo-project-icon-suggestions.md`.
- **Other entities** — **Task membership** is wired (`projectId` on `tasks`,
  migration 0047): the project screen lists the project's open tasks and adds one
  from a plus-button quick-add bar (grooming). A task added from a project is
  parked (grooming is collect-then-take-on). **Waiting conditions** attach to a project
  (see `docs/entities/waiting-condition.md`). **Refine provenance**:
  `sourceCaptureId` (migration 0050) records the capture a project was refined
  from. The AI Capture → Project conversion is a later slice.

## Shared view rule

The Projects list region gates on the row count, not the collection's
`isLoading`, via the shared `listView` helper in `@zero/agent-core` (one rule for
every entity list: rows whenever present; the spinner only when empty and
loading). The persisted collection hydrates the local snapshot before
the network sync marks ready, so gating on `isLoading` would hide a hydrated
snapshot behind a spinner.

## Next

- **Task → Project (slice B)** — a Task belongs to a Project (adds `projectId` on
  `tasks`); the sheet grows the project's Task list.
- **AI conversion** — swipe a Capture, propose a Project, confirm (later slices of
  `docs/plans/todo-capture-to-project-ai.md`).
