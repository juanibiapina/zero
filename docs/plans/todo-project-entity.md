# Project entity (slice A of Capture → Project)

Detailed implementation plan for **slice A** of `docs/plans/todo-capture-to-project-ai.md`:
introduce the **Project** entity with a project-creation UI that works well, with
**no AI involved**. Projects are created and managed by hand. The AI conversion
(swipe-left → propose → confirm) is later slices and out of scope here.

Project is **entity #3** in the todo app (after Capture and Task). Read
`docs/todo-app.md` for the product vision and `docs/entities/task.md` for the
sibling pattern this mirrors.

## Goal

A user can create a Project (name + icon, optional notes, a status) from a good
creation UI on web and mobile, see it in a Projects list grouped by status,
change its status or edit it, and have it persist and sync offline — exactly the
way Captures and Tasks already work. No Tasks-in-a-Project and no AI yet.

## Background: the sibling pattern this follows

Capture (#1) and Task (#2) are built as near-identical **structural siblings** at
every layer, and the duplication is intentional and kept in lockstep. Project
copies the same five-layer stack:

- **Server store** (`apps/agent-api/src/store/`): `DbCaptureStore` /
  `DbTaskStore` are do-orm classes with domain verbs (`add` dedupes on the
  client-minted id; `list`; a removal verb). Standalone from the agent's
  `DbStore` on purpose (one namespace per product area).
- **Table + migration** (`apps/agent-api/src/UserDO/db/`): a table in `schema.ts`,
  a numbered `.sql` migration, registered in `migrations.ts`. Latest is `0045`.
- **UserDO methods** (`apps/agent-api/src/UserDO/index.ts`): thin pass-throughs
  (`addCapture`, `listCaptures`, …) the routes call.
- **Routes** (`apps/agent-api/src/routes/`): `createCapturesRoutes` /
  `createTasksRoutes`, OpenAPI/zod, mounted in `app.ts` via `app.route("/", …)`.
- **Shared data layer** (`packages/agent-core/src/`): per-entity folder with
  `types.ts`, `collection.ts` (a TanStack DB collection factory: in-memory
  fallback + durable persisted offline mode + a pure reconcile-writes helper),
  and `view.ts` (a `*View` helper that gates the list region on row count, not
  `isLoading`, so a hydrated local snapshot never flashes a spinner). Exported
  from `index.ts`. The Task layer already **reuses** `StartOfflineExecutor` and
  `WarnFn` from `captures/collection.ts` rather than re-declaring them.
- **Per-surface wiring**: web `lib/<entity>.ts` (same-origin cookie REST) +
  `lib/<entity>-collection.ts` (singleton, OPFS persistence); mobile `lib/api.ts`
  (cross-origin Bearer REST) + `lib/<entity>-collection.ts` (op-sqlite + shared
  outbox singleton) + a `use-<entity>-api.ts` hook. Both surfaces read the
  collection through a `useLiveQuery` and write with optimistic transactions,
  surfacing failures via `tx.isPersisted.promise`.

Client rows carry a **client-minted UUID id** that the server persists verbatim;
it is the primary key, the dedupe key for offline replay, and the reason
optimistic rows never flicker.

Nav today: web has a `SideNav` (desktop left rail + mobile bottom bar) with
Captures + Upcoming, driven by a `NAV_ITEMS` array; the `/captures` and
`/upcoming` routes are **unlinked** from the marketing app and reached by URL.
Mobile has a `NativeTabs` navigator in `app/(signed-in)/_layout.tsx` with one
`Trigger` per screen file (`index`, `upcoming`).

## Key decisions

### Data shape (only the name is required at creation)

`Project`. **Only `title` is required to create.** `icon`, `description`, and
`status` all take defaults at creation and are set/changed **afterward** by
interacting with the project (see Creation UI). Creation stays fast, like a
Capture; the richness is added later, in place.

- `id` — client-minted UUID, server-persisted verbatim (dedupe key).
- `title` — required, non-empty string. **The one field at creation.** Named by
  its **outcome**, measurable and observable (see Naming below).
- `icon` — a string holding a single **emoji** (e.g. `👶`, `🎓`, `🏠`). Emoji is
  the simplest cross-platform icon: it renders in plain text on web and React
  Native with no asset pipeline, and covers the vision's "baby face, diploma"
  examples. Keep the column a plain string so the representation can later evolve
  to SF Symbols / custom art without a data migration. **Defaults** to a neutral
  `📁`; changed after creation by tapping the icon.
- `description` — nullable free text (notes). Optional; **empty by default**,
  added after creation. A goal-oriented Project benefits from a sentence of
  intent, but it is never asked for up front.
- `status` — one of `active` | `next` | `waiting` | `backlog` | `done` (see the
  Status model below). This replaces the earlier binary active/archived. `done`
  is the terminal state (the sibling of Capture's `process` / Task's `complete`);
  the other four are the working states. **Defaults** to `next` (recommended;
  open — see Status model); changed after creation from the detail sheet's Status
  group.
- `createdAt` — ISO timestamp. Within a status group the order is `createdAt`
  ascending (same as Task). No manual `sortKey` reorder in v1 — flag as a later
  add if wanted.

### Naming: outcome-based, measurable and observable

A Project is named by the **outcome** it reaches, phrased so you can observe and
measure when it is done — not a vague area of life. A good name is the one
deliberate act of creation, so the UI teaches it (the way Things 3's date UI
teaches good task hygiene). Surface the guidance as **persistent helper text
below the field**, NOT as the placeholder: a placeholder is not a label — it
disappears on the first keystroke, screen readers skip it, and its low contrast
hurts (NN/g, Intuit, W3C WAI). The placeholder may hold at most one short example.
Examples (good → measurable/observable): "Run a 5K under 30 min", "Have a baby",
"Move into the new house". Weaker (an area, not an outcome): "Fitness", "House".
The guidance is advisory in slice A (free text, not validated); enforcing or
auto-suggesting outcome names is a natural later job for the AI (a Preferences-
style rule, see `docs/todo-app.md`).

Deferred on purpose (no speculative columns before their behavior is designed,
per `docs/entities/task.md`): no `sortKey`, no `color`, no `slots`, no year/time
horizon and no category (see Status model), and crucially **Task membership lives
on Task** (`projectId` on the `tasks` table) and is **slice B**, not here.

### Status model (confirmed from the user's notes vault, `Projects.md`)

The status enum is **`active`, `next`, `waiting`, `backlog`, `done`** — the exact
sections the user already keeps by hand. Meaning: `active` = being worked now;
`next` = on deck; `waiting` = blocked on someone/something; `backlog` = someday
pile (large); `done` = finished.

- **Default on create:** **`next`** (recommended). Status is **not** chosen at
  creation. A *manually* created Project is a deliberate act ("I'm adding this
  because I intend to do it"), so it should land visible and one step from Active
  — not vanish into a collapsed Backlog. `backlog` is the alternative default and
  fits AI/bulk intake later (an undecided pile). Whichever is chosen, the
  just-created row must be **visible** (scroll-to / brief highlight) so creation
  never feels lost. (Open decision — see Open questions.)
- **List model:** the Projects screen shows the four working statuses **grouped
  into sections** (Active, Next, Waiting, Backlog), the way Upcoming groups by
  day. Section headers carry a **count** ("Backlog · 37") and are **collapsible**;
  Active and Next are expanded by default, Backlog collapses by default when
  large. **Empty sections are hidden** (no empty "Active" placeholder). Within a
  group, order by `createdAt` (manual reorder is a later add). `done` is excluded
  from the default list; a "Done" archive view is **deferred** (keep slice A
  tight). The server `list()` returns non-`done` projects; a pure
  `projectsByStatus` helper in `@zero/agent-core` groups them into ordered
  sections (mirrors `upcomingSections`). This grouped-list shape follows Linear
  (list groups by status to surface active work; boards are a separate, later,
  web-only view) and guards against the OmniFocus backlog-garbage failure by
  keeping Backlog collapsed and out of the way.
- **Removal/lifecycle verb** is **`setStatus`**, not a binary archive: moving a
  Project between the five states (including to `done`) is one status change.
- **Out of scope (observed but not status):** `Projects.md` also has year buckets
  (`2026`, `2027`) and a `Coding Projects` category. Those are separate axes (a
  time horizon and a type), not the status field; do not fold them in. They are
  candidate future dimensions, noted so the model is honest, not built here.

### Rule-of-Three: build the third sibling now, extract the base right after

`docs/todo-app.md` says to extract a shared base (store, collection factory, list
screen) at entity #3 and not before. The safest reading of the Rule of Three is:
the third example must **exist** before you extract from it — extracting while
authoring the third is guessing at the seam mid-keystroke. So:

- **In this slice:** build Project as a third full sibling of Capture/Task. This
  gets the working creation UI (the user's priority) fastest and produces the
  third concrete example.
- **Immediately after (its own follow-up, before slice B):** extract only the
  genuinely shared plumbing now visible in triplicate — the offline collection
  factory (in-memory + persisted + reconcile-writes), the `*View` count-gate
  helper, and the id/createdAt/dedupe conventions. **Never** extract the domain
  verbs (`process` / `complete` / `archive`): keeping those per-entity is what
  preserves the Minecraft-block rule that adding an entity forces wiring its own
  behavior.

Alternative considered and rejected for this slice: extract the base from
Capture+Task *first*, then build Project on top. It is less total code, but it
mixes a refactor of two shipped entities with the introduction of a third
differently-shaped one (Project has no `showUpDate`, adds `title`/`icon`/`status`
and a richer form), doubling the risk on the slice whose real goal is the UI.

### Slicing: vertical, and each slice ships web + mobile

This slice-A plan is itself cut into **vertical slices** (A1–A3), each crossing
every layer (DB → API → shared data layer → UI) and ending at something the user
can do. Crucially, **each slice ships on both web and mobile** — there is no
mobile-catch-up slice, which would be a horizontal "mobile layer". Within a slice,
web can be built minutes before mobile (it iterates without a dev build), but the
slice is not done until both surfaces ship.

The concrete pieces per layer are catalogued below (Technical approach); the
**Slices** section maps each piece to the slice that lands it, with a per-slice
acceptance checkpoint, tests, and changelog.

## Technical approach, layer by layer (reference)

The full catalogue of pieces to build. The Slices section says *when* each lands;
this section says *what* each is. Names below are the concrete files to add, each
mirroring its Capture/Task twin.

### Server (`apps/agent-api`)

- `src/UserDO/db/migrations/0046_projects.sql` — `CREATE TABLE projects` (id PK,
  title, icon, description nullable, status NOT NULL default `'next'` (tracks the
  open Status-model default), createdAt). A partial index `projects_open ON
  ("createdAt") WHERE status !=
  'done'` for the list query (mirrors `tasks_open`; keeps a large `done` pile out
  of the index).
- `src/UserDO/db/schema.ts` — add the `projects` do-orm table.
- `src/UserDO/db/migrations.ts` — import `0046` and add it to the `migrations`
  map.
- `src/store/projects.ts` — `DbProjectStore` with `add(id, title, opts?)` (dedupe
  on id; `opts` may carry icon/description/status but creation normally passes
  only title, so the store applies defaults: icon `📁`, description `null`,
  status `next`), `list()` (status != `done`, `createdAt` asc), `setStatus(id,
  status)`, `edit(id, fields)` (title/icon/description), each returning the
  client-facing `Project` or null. Mirror `DbTaskStore`; the partial index covers
  non-`done` rows.
- `src/UserDO/index.ts` — construct `DbProjectStore` and expose `addProject`,
  `listProjects`, `setProjectStatus`, `editProject`.
- `src/routes/projects.ts` — `createProjectsRoutes`:
  - `GET /api/projects` → `{ projects }` (non-`done`, so the four working
    statuses).
  - `POST /api/projects { id, title, icon?, description?, status? }` →
    `201 { project }`; the client normally sends only `id` + `title` and the
    server fills the defaults (icon `📁`, description `null`, status `next`).
    `400` on empty title, non-UUID id, or an unknown status.
  - `PATCH /api/projects/{id} { title?, icon?, description?, status? }` →
    `200 { project }` / `400` (no fields / bad status) / `404`. Carries both edit
    and the `setStatus` transition (mirrors the captures PATCH that carries edit
    + reschedule + reorder).
  - Logs `project_added` / `project_status_changed` (when `status` changes) /
    `project_edited`.
- `src/app.ts` — `app.route("/", createProjectsRoutes())`.

### Shared data layer (`packages/agent-core/src/projects/`)

- `types.ts` — the `Project` type.
- `collection.ts` — `ProjectsRest` (`fetchProjects`, `addProject`,
  `setProjectStatus`, `editProject`), `ProjectsApi` (`collection`, `add`,
  `setStatus`, `edit`, `offline`, `refetch`, `getLoadError`,
  `subscribeLoadError`), `createInMemoryProjectsApi`,
  `createPersistedProjectsApi`, `createProjectsApi`, and a pure
  `projectsReconcileWrites`. **Reuse** `StartOfflineExecutor` / `WarnFn` from
  `../captures/collection`. Persisted collection id `"projects"`; query key
  `["projects"]`; outbox mutation fns `addProject` / `setProjectStatus` /
  `editProject`. `add(title)` mints the client id and the icon/description/status
  defaults locally so the optimistic row renders immediately, matching what the
  server fills. A row leaves the collection when its status becomes `done` (the
  server stops returning it), so the reconcile delete-path handles it exactly
  like a completed Task. Copy the readiness/flicker mechanics verbatim from
  `tasks/collection.ts` (mark-ready-from-snapshot, reconcile after each REST call
  before the optimistic overlay drops).
- `view.ts` — `projectsView({ count, isLoading, loadError })` → `rows | loading |
  empty | error`, identical rule to `todayView`.
- `sections.ts` — a pure `projectsByStatus(projects)` that groups the four
  working statuses into ordered sections (Active, Next, Waiting, Backlog),
  mirroring `captures/upcoming.ts`'s `upcomingSections`. Unit-tested in isolation.
- `index.ts` — export the `Project` type (and a `ProjectStatus` union), the
  collection API surface, `projectsView`, and `projectsByStatus`.

### Web (`apps/agent-web`)

- `src/lib/projects.ts` — same-origin REST (`fetchProjects`, `addProject`,
  `setProjectStatus`, `editProject`), mirroring `lib/captures.ts`.
- `src/lib/projects-collection.ts` — the OPFS-persisted singleton, mirroring
  `lib/captures-collection.ts` (shares `getAppPersistence` and the module
  `queryClient`).
- `src/pages/ProjectsPage.tsx` — the status-grouped list (`projectsByStatus`),
  name-only create, and the tap-to-open detail sheet (see Creation UI).
- `src/components/ui/sheet.tsx` — a minimal bottom-anchored slide-up sheet
  (Close + Esc/Back), **shared with the Captures Slice 3 sheet**; build it once. If
  Captures Slice 3 lands first, reuse its sheet instead of adding a second.
- `src/App.tsx` — add `<Route path="projects" element={<ProjectsPage />} />`
  (unlinked from marketing, like `/captures`).
- `src/components/SideNav.tsx` — add a `Projects` entry to `NAV_ITEMS` with a
  folder icon.

### Mobile (`apps/agent-mobile`)

- `src/lib/api.ts` — add `fetchProjects` / `addProject` / `setProjectStatus` /
  `editProject` (Bearer, mirror the Task helpers).
- `src/lib/projects-collection.ts` + `setProjectsTokenGetter` — the op-sqlite +
  shared-outbox singleton, mirroring `lib/captures-collection.ts`.
- `src/lib/use-projects-api.ts` — the hook, mirroring `use-captures-api.ts`.
- `src/app/(signed-in)/projects.tsx` — the Projects list screen, a `SectionList`
  grouped by status (`projectsByStatus`), with the name-only create entry and the
  tap-to-open detail sheet (`@expo/ui` `BottomSheet`), **shared with the Captures
  Slice 3 sheet**. Extend the app's `BackHandler` chain so Back dismisses the
  sheet first.
- `src/app/(signed-in)/_layout.tsx` — a third `NativeTabs.Trigger name="projects"`
  (`sf="folder"`, `md="folder"`, label `Projects`).

## Creation UI (the heart of this slice)

Design goal: creating a Project is **fast and name-only**, close to the Capture
quick-add. The one deliberate act is naming the outcome well; icon, status, and
description all default and are enriched afterward in the detail sheet (tap the
row). Do **not** put a multi-field form in the create path.

**Create (name only):**

- **Web** (`ProjectsPage.tsx`): a single **New project** entry — a text input
  (reuse `ui/input`) with a **persistent one-line helper below the field** teaching
  outcome-based naming (measurable, observable; see Naming), and at most a short
  example in the placeholder. Submit on Enter → optimistic `api.add(title)` with
  the icon/status/description defaults, clear, keep focus for the next one (like
  the Captures quick-add). Surface a write error via `tx.isPersisted.promise`.
  Create disabled/no-op on empty title. Scroll to / briefly highlight the new row
  so it is not lost.
- **Mobile**: reuse the existing `ui/fab.tsx` to open a small name entry (a
  `@expo/ui` `TextField` in a compact sheet, or the same quick-add bar the
  Captures screen uses), the same helper text below the field, same defaults. On
  submit: optimistic `api.add`, dismiss. No emoji/status/description at this step.

**Enrich after creation — tap the row to open a detail bottom sheet.** The row is
a **single tap target** (standard mobile pattern), which removes the inline-edit
discoverability risk (NN/g, PatternFly) entirely: there are no hover-only
affordances on the row. Every edit and the status change live in one **slide-up
sheet**, the exact pattern the Captures roadmap adopts in its Slice 3 (tap a
capture → detail sheet). Reuse the same sheet primitive:

- **Mobile:** `@expo/ui` `BottomSheet` (native; already a dep) — not
  `@gorhom/bottom-sheet` or a hand-rolled Reanimated sheet. Explicit Close (X);
  extend the app's `BackHandler` chain so Back dismisses the sheet first.
- **Web:** a minimal bottom-anchored slide-up sheet under `components/ui` (there is
  no sheet component in `agent-web`; do not pull in shadcn/`@zero/ui`). Close (X);
  Esc/Back dismiss.

The row itself is **display-only**: emoji icon + title + optional muted
description. It carries no status badge (the section already says the status) and
no hover controls. Tapping it opens the sheet.

**Sheet contents (slice A):**

- **Icon:** the emoji, tap to open the curated picker (a small set, not a full
  keyboard: `📁 👶 🎓 🏠 🎬 ✈️ 📚 💼 ❤️ 💪 🧳 🎯`) → `api.edit({ icon })`.
- **Title:** an editable text field → `api.edit({ title })`.
- **Description:** an editable multi-line field, the sentence of intent →
  `api.edit({ description })`.
- **Status:** a **Status** group — the five states as selectable rows, current one
  marked — tap one → `api.setStatus`. Fully specified in **Changing status** below.

The sheet is where the Tasks-in-a-Project list will later attach (slice B); slice A
ships only the fields + status, so building the sheet now does not pull in the
parked Task stack. Coordinate with the Captures Slice 3 sheet: build one shared
bottom-sheet primitive (web minimal + the mobile `@expo/ui` wrapper), used by both
Captures and Projects.

The list renders the four working statuses as labeled sections
(`projectsByStatus`), reusing the count-gated `view` pattern from `HomePage.tsx`.
**Section headers carry a count and collapse** (Active + Next expanded, Backlog
collapsed when large); **empty sections are hidden**; ordering within a group is
`createdAt`. On mobile use sticky collapsible `SectionList` headers; the
name-entry and the detail sheet are the two sheets described above.

### Changing status (interaction spec)

Status is changed **inside the detail sheet** (tap the row → sheet → Status),
which is what makes it "super simple": one obvious place, no hidden per-row
controls, and the same tap-to-open pattern as every other project edit and as the
Captures detail sheet.

- **Control:** a **Status** group in the sheet — the five states, **Active, Next,
  Waiting, Backlog, Done**, in fixed order as selectable rows, with the **current
  one marked** (checkmark). Not a swipe (binary-only, why Captures uses it just for
  postpone) and not tap-to-cycle (ambiguous across five ordered states). Tapping a
  row = pick that status.
- **Select:** tapping the current status is a **no-op**; tapping another calls
  `api.setStatus(id, next)` and dismisses the sheet.
- **Result (optimistic):** the write fires immediately and the underlying row
  **re-groups**: it exits its current section (the gap closes) and enters the
  target section (subtle enter), reusing the Captures list's layout/exit animation.
  It is **not** a literal fly-from-A-to-B; it is exit-here + enter-there. If the
  target section is **collapsed**, the row is not shown — only that section's
  **count increments**. On a write failure the collection rolls back (the row
  returns to its old section) and the error surfaces like every other write.
- **No drag-between-sections** in v1. Dragging a row to another section
  (Kanban-style) is a later add; the sheet's Status group is the only way to
  change status.

**Done is the one-way-trap guard.** Selecting **Done** removes the row from the
working list, and slice A ships **no Done view** (open question 3). To avoid a
project vanishing with no way back, after the sheet dismisses the row is left
**briefly in place struck-through with an inline "Undo" (~5s)** before it animates
out; Undo within the window calls `api.setStatus(id, previousStatus)`. This is a
row-level affordance — **no toast/snackbar component is needed** (there is none in
these surfaces today). If open question 3 instead resolves to ship a **collapsed
"Done" section**, that section provides recoverability (reopen it, pick another
status) and the inline Undo becomes unnecessary — decide the two together.

Tapping a project row opens the detail sheet (fields + status). The sheet is
deliberately light in slice A; the **Tasks-in-a-Project list** that later lives in
it (or in a fuller detail screen) is slice B (Task-under-Project), so slice A does
not pull in the parked Task stack.

## System-wide impact

- New public routes under `/api/projects` on `zero-api`; no change to existing
  Capture/Task routes. Per-user isolated in `UserDO` like the others.
- A new `projects` table + migration `0046`; migrations are append-only and run
  on DO init, so no backfill and no touch to `captures`/`tasks`.
- Web bundle gains a route + nav item + a minimal sheet component; mobile gains a
  native tab and an `@expo/ui` `BottomSheet`. A new `NativeTabs.Trigger` and the
  `BottomSheet` are native, so they need a **fresh dev build** to appear on device
  (pure-JS reload will not show them). This overlaps the Captures Slice 3 sheet —
  build the shared sheet primitive once.
- No agent, Telegram, or knowledge-model surface is touched; the store is
  standalone and does not widen the agent's `DbStore`.

## Slices

Three vertical slices, each **web + mobile**, each its own PR shipping its docs +
changelog. Then a non-vertical extraction follow-up. Within a slice, build web
first (it needs no dev build) but ship both before closing the slice.

### A1 — Create & list (web + mobile) — SHIPPED 2026-09-04

The walking skeleton: the whole stack proven on the thinnest path. Detailed plan:
`docs/plans/todo-project-entity-a1.md`. Shipped as described (name-only create +
flat list on both surfaces; the full `projects` table incl. status/icon/
description defaults landed in migration `0046`, with only `add`/`list` wired).
On `main` (commit `807e8d7`); web verified locally and auto-deploying; mobile
not device-verified yet (needs an EAS dev build for the new native tab).

- **User value:** jot a project by name and see your projects. Replaces the raw
  notes list.
- **Server:** migration `0046` + `projects` in schema/migrations; `DbProjectStore`
  `add` + `list`; `GET`/`POST /api/projects`; UserDO `addProject`/`listProjects`;
  mount in `app.ts`.
- **Shared:** `packages/agent-core/src/projects/` `types.ts`, `collection.ts`
  (`add`/list, reconcile, in-memory + persisted), `view.ts`; exports.
- **Web:** `lib/projects.ts` + `projects-collection.ts`; `ProjectsPage` with the
  name-only create (outcome helper text) and a **flat list** (no status UI yet —
  grouping is meaningless before status can change); route + `SideNav` entry.
- **Mobile:** `lib/api.ts` project helpers + `projects-collection.ts` +
  `use-projects-api.ts`; `projects.tsx` flat list + name entry; third
  `NativeTabs.Trigger`. **Native:** the new tab needs a fresh dev build.
- **Tests:** `routes/projects.test.ts` (add defaults + dedupe + list);
  `collection.test.ts` (reconcile); a mobile screen jest test (create → `api.add`,
  empty disabled). **Acceptance:** create a project on web and mobile; it lists,
  persists across reload, syncs; mobile add works offline with no dup on replay.

### A2 — Status: group + change (web + mobile) — SHIPPED

The core: the five-status model becomes real. Shipped as described (detailed
plan: `docs/plans/todo-project-entity-a2.md`). Server `setStatus` + `PATCH
/api/projects/{id}` with `list()` scoped to non-`done`; a pure `projectsByStatus`
grouping helper and `api.setStatus` in the collection (offline-replaying); on both
surfaces a status-grouped collapsible list and a reusable detail bottom sheet
(web `@radix-ui/react-dialog`, mobile universal `@expo/ui` `BottomSheet`) with a
Status group; `done` removes the row with an inline ~5s Undo. Web verified via
package tests + typecheck + lint; mobile via jest + typecheck + lint (on-device
Maestro after an EAS dev build, since the `@expo/ui` sheet is native).

- **User value:** organize projects across Active/Next/Waiting/Backlog, move them,
  finish them.
- **Server:** `store.setStatus`; `PATCH /api/projects/{id} { status }`; UserDO
  `setProjectStatus`; `list()` scoped to non-`done`; `project_status_changed` log.
- **Shared:** `sections.ts` `projectsByStatus`; `api.setStatus` in the collection
  (+ the `done`-leaves-collection reconcile path); export.
- **Both surfaces:** grouped sections (counts, collapse, hide-empty); the **detail
  sheet** (built here — shared with Captures Slice 3: web minimal `ui/sheet`,
  mobile `@expo/ui` `BottomSheet`) with a **Status group**; optimistic re-group on
  change; **Done + inline Undo (~5s)**. Back/Esc/Close dismiss the sheet.
  **Native:** the `BottomSheet` needs a fresh dev build.
- **Tests:** route (`PATCH status`, `done` drops from list); `projectsByStatus`
  (grouping + order); mobile screen test (open sheet → pick status → row moves;
  Done → Undo → leaves). **Acceptance:** change status from the sheet on both
  surfaces; the row re-groups; Done removes it with a working Undo.

### A3 — Enrich in the sheet (web + mobile) — SHIPPED

Shipped as described (detailed plan: `docs/plans/todo-project-entity-a3.md`).
Server `edit` + a widened `PATCH /api/projects/{id}` carrying
title/icon/description alongside status; `api.edit` in the collection (offline
replaying, `setStatus`/`edit` disambiguated by the changed field set); on both
surfaces the detail sheet gained a curated emoji picker, an editable title, and an
editable notes field, committing on blur/submit (icon on tap) and keeping the
sheet open. Verified via package tests + typecheck + lint on all four packages;
mobile on-device Maestro after an EAS dev build (the `@expo/ui` `TextInput` is
native). With A3, slice A is complete; the Rule-of-Three extraction is the next
change.

- **User value:** rename a project, give it an icon, add a sentence of intent.
- **Server/Shared:** `store.edit` + `PATCH { title?, icon?, description? }`;
  `api.edit`.
- **Both surfaces:** the detail sheet gains the emoji picker + title field +
  description field.
- **Tests:** route (edit fields, 400/404); mobile screen test (edit → `api.edit`).
  **Acceptance:** edit icon/title/description from the sheet on both surfaces;
  changes persist and sync.
- **Merge option:** A3 is small and A2 already builds the sheet — fold it into A2
  as one "detail sheet: status + edit" slice if that reads cleaner.

### Docs + changelog (in each slice's PR)

Every slice updates `docs/entities/project.md` (create it in A1, grow it per
slice), the `docs/todo-app.md` tracking + entity wiki, the slice-A status in
`docs/plans/todo-capture-to-project-ai.md`, and both `apps/agent-web/CHANGELOG.md`
+ `apps/agent-mobile/CHANGELOG.md` — for the capability that slice ships, from the
user's perspective.

### Follow-up (NOT a vertical slice) — Rule-of-Three extraction

After A3, with three siblings (Capture, Task, Project) in hand, extract the shared
plumbing (offline collection factory, `*View` count-gate, id/createdAt/dedupe
conventions) — never the domain verbs. Internal refactor, no user value, its own
change before slice B.

## Test strategy

- **Server** (`routes/projects.test.ts`, mirror `captures.test.ts`): add returns
  201 from `id` + `title` alone, defaults icon `📁` / description `null` / status
  `next`, and dedupes a replayed id; add with explicit fields persists them; an
  unknown status is `400`; list returns non-`done`
  rows oldest-first; a PATCH to `status: done` drops the row from list; edit
  updates fields; 400/404 paths. The do-orm store is a **local-substitutable**
  dependency (SQLite runs in the test), so it is exercised through the routes, not
  mocked.
- **Shared data layer**: `projectsReconcileWrites`, `projectsView`, and
  `projectsByStatus` (grouping + section order) are pure (**in-process**) —
  unit-test them directly, as `tasksReconcileWrites` / `todayView` /
  `upcomingSections` are.
- **Mobile**: a jest test for the Projects screen (render status-grouped list,
  open the name entry and submit → `api.add`, empty name disables create, tap a
  row to open the detail sheet, edit title/icon/description → `api.edit`, pick a
  status in the sheet → `api.setStatus` and the row moves section, set Done → row
  shows Undo then leaves), mirroring `__tests__/index.test.tsx`. Mock the
  `@expo/ui` `BottomSheet` as a passthrough. The op-sqlite native path falls back
  to in-memory under jest, so no native mock is needed.
- **On-device**: a Maestro flow (create a project, see it listed) run in the
  Mobile E2E workflow / on the Pixel 7; requires an EAS dev build for the new
  native tab + `@expo/ui` form.
- Replace, don't layer: any temporary pure helper extracted only for testability
  gets tested through the collection/route interface, not in isolation.

## Documentation strategy

- **New**: `docs/entities/project.md` — the source of truth for the entity,
  following the `docs/entities/task.md` structure (What it is / Vocabulary / Data
  shape / Behavior / Interactions per system / Next). Document the intended
  **Task → Project** link (`projectId` on `tasks`) under "Next" as deferred, the
  way task.md documents its deferred columns.
- **Update**: `docs/todo-app.md` entity wiki (Project: draft → built) and the
  Project-tracking section (Project shipped as #3; Rule-of-Three extraction is the
  tracked follow-up). Update `docs/plans/todo-capture-to-project-ai.md` slice A
  status. One fact, one source: link rather than restate the sibling mechanics.
- **Changelog** (user-visible, same change): `apps/agent-mobile/CHANGELOG.md`
  (mobile can create projects) and `apps/agent-web/CHANGELOG.md` (web `/projects`
  can create projects). Both from the user's perspective, no internals.

## Skills to use

- `vocabulary` — keep module/interface/seam/adapter terms consistent while
  building.
- `deep-modules` — classify the do-orm store (local-substitutable) and keep the
  collection factory a deep module behind `ProjectsApi`.
- `tdd` — server routes and the pure agent-core helpers are natural red-green.
- `expo-ui` — the mobile detail `BottomSheet`, the name-entry `TextField`, the
  in-sheet fields, the Status group, and the emoji picker.
- `expo-animation` — the detail sheet's coexistence with the list, and the
  re-group / Done exit animations.
- `expo-router` — the mobile name-entry sheet / navigation.
- `expo-native-ui` / `expo-design-system` — native-feeling rows, collapsible
  section headers, the curated icon set.
- `impeccable` — polish the web Projects list, create field, and inline
  affordances.
- `changelog` — before editing either CHANGELOG.
- `git-commit` — when committing; keep the docs + changelog in the same change.
- `reproducible-locally` — decide how to prove it works given this box cannot run
  `workerd` (package tests + typecheck + lint + on-device Maestro after EAS build,
  and post-deploy verification).

## Acceptance criteria

- A user creates a Project by entering **only a name** (with outcome-naming
  guidance in **helper text**, not the placeholder) on **both** web (`/projects`)
  and mobile; it appears **visibly** in the **Next** section (default status) with
  the default `📁` icon.
- **Tapping a project row opens a detail bottom sheet** where the user edits the
  icon (picker), title, and description, and changes the status; Close/Back/Esc
  dismiss it.
- The Project persists across reload and syncs; mobile creation works **offline**
  (outbox replays) with no duplicate on a replayed client id.
- The user **changes status from the sheet's Status group** (five states, current
  one marked); the underlying row re-groups to the target section optimistically.
- Setting **Done** removes the row from the working list, with an inline **Undo
  (~5s)** so it is not a one-way trap.
- The list is **grouped into Active / Next / Waiting / Backlog sections**; done is
  excluded.
- Server routes, the agent-core reconcile + view helpers, and the mobile screen
  test are green; `typecheck` and `lint` pass for `@zero/agent-api`,
  `@zero/agent-core`, `@zero/agent-web`, and `@zero/agent-mobile`.
- `docs/entities/project.md` exists; `docs/todo-app.md` and the slice-A plan are
  updated; both changelogs carry a user-facing entry.
- No AI and no Task-in-Project (later slices). The detail **sheet** ships (fields +
  status); a fuller detail screen with the project's Tasks is slice B.

## Risks and mitigations

- **New native surfaces need a fresh dev build** (NativeTabs trigger, `@expo/ui`
  `BottomSheet`) before on-device runs; a pure-JS reload silently omits them. →
  Build a dev client before Maestro; call it out in the mobile phase.
- **The detail sheet overlaps Captures Slice 3.** → Build one shared bottom-sheet
  primitive (web minimal + mobile `@expo/ui` wrapper); if Captures Slice 3 ships
  first, reuse its sheet. Sequence with whoever touches the sheet first to avoid
  two implementations.
- **Third full sibling adds duplication.** → Intentional and bounded; the
  extraction follow-up (with tests green across three examples) removes it before
  slice B.
- **This dev box cannot run `workerd`**, so no full local worker + no local
  end-to-end. → Verify via `pnpm --filter @zero/agent-api test`, `@zero/agent-core`
  tests, typecheck, lint, mobile jest, on-device Maestro, and post-deploy checks.
- **Icon representation may change** (emoji → SF Symbols/custom). → `icon` stays a
  plain string column, so the representation can evolve with no migration.
- **Emoji rendering differs across platforms.** → Ship a small curated, tested
  set rather than a free emoji keyboard for v1.
- **Backlog turns into "garbage" you stop checking** (the OmniFocus Someday/Maybe
  failure). → Backlog is a collapsed, counted section, kept out of the way; the
  default status is `next` (visible) so new work does not sink into it.

## UI design basis (researched)

The Projects tab shape is grounded in current product patterns, not invented:

- **Grouped list, not a board** — Linear groups issues by status in list views to
  surface active work and reserves boards for workflow-order columns; Todoist
  offers both and lets you toggle. On a phone-first, 5-status, single-user tool a
  board means horizontal columns and a dominating Backlog column, so the grouped
  list is the v1 default and a board is a later, optional, web-only view.
- **Opinionated defaults, minimal statuses** — Linear's guidance; the five
  statuses come straight from the user's own `Projects.md`, so they are the real
  working set, not a guess.
- **Teach through the UI** — Things 3 teaches good task hygiene via its date UI;
  the create field's helper text teaches outcome-based naming the same way.
- **Helper text, not placeholder** — a placeholder is not a label (disappears on
  input, skipped by screen readers, low contrast): NN/g, Intuit, W3C WAI.
- **Detail bottom sheet over inline affordances** — rather than scatter
  hover/tap edit controls on the row (whose discoverability is the known
  inline-edit risk: PatternFly, Pencil&Paper), the whole row is one tap target that
  opens a slide-up **detail sheet** holding every edit + the status change. This is
  the pattern the Captures roadmap adopts (Slice 3) and the right one for a short
  edit/detail task (NN/g bottom sheets: give an explicit Close, support Back/Esc).
- **Progressive disclosure** — show the few important things first, defer the rest
  (NN/g): Active + Next up front, Backlog collapsed, Done hidden.

## Open questions

1. **Default status for manual creation:** `next` (recommended — visible, one step
   from Active, matches "I'm adding this to do it") or `backlog` (undecided pile)?
2. **Section collapse state:** persist per user, or reset on each open? (Persist
   is nicer; small extra client state.)
3. **Done recoverability** (decide with the interaction spec): defer the Done view
   and rely on the **inline row-level Undo (~5s)** after setting Done, or ship a
   **collapsed "Done" section** from day one (which needs a way to load done rows)
   and drop the inline Undo? Recommendation: inline Undo for slice A, Done view
   later.
