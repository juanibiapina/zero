# Slice A1 — Project create & list (web + mobile) — SHIPPED 2026-09-04

Detailed implementation plan for **slice A1** of `docs/plans/todo-project-entity.md`
(itself slice A of `docs/plans/todo-capture-to-project-ai.md`). A1 is the walking
skeleton: the whole five-layer stack proven on the thinnest path — a user jots a
Project by name and sees the list, on **both** web and mobile, persisted and
offline-safe. No status UI, no detail sheet, no AI. Those are A2/A3.

Read the parent plan for the full slice-A design and rationale; this document
carries only what A1 lands and the concrete files to touch.

## Goal

A user creates a Project by entering **only a name** on web (`/projects`) and
mobile (a third tab); it appears in a **flat list**, persists across reload, and
syncs. Mobile creation works **offline** (outbox replays) with no duplicate on a
replayed client id. The default `📁` icon renders next to the title; status
exists in the data but has no UI yet.

## The sibling to copy

Project is entity #3, built as a near-identical structural sibling of Capture and
**Task**. Task is the closest match (it has a `title`-like text field and a
`complete`/terminal verb); copy its files almost verbatim, renaming `task`→
`project`, `text`→`title`, and dropping `showUpDate`. The Task data layer already
exists end-to-end but has **no UI**, so A1 is the first Project-specific screen.

Concrete siblings to mirror, by layer:

| Layer | Task sibling (copy this) |
|---|---|
| Migration | `apps/agent-api/src/UserDO/db/migrations/0043_tasks.sql` |
| Schema table | `tasks` in `apps/agent-api/src/UserDO/db/schema.ts` |
| Server store | `apps/agent-api/src/store/tasks.ts` (`DbTaskStore`) |
| UserDO methods | `addTask`/`listTask` in `apps/agent-api/src/UserDO/index.ts` |
| Routes | `apps/agent-api/src/routes/tasks.ts` (`createTasksRoutes`) |
| Shared type | `packages/agent-core/src/tasks/types.ts` |
| Shared collection | `packages/agent-core/src/tasks/collection.ts` |
| Shared view | `packages/agent-core/src/tasks/view.ts` |
| Web REST | `apps/agent-web/src/lib/tasks.ts` |
| Web singleton | `apps/agent-web/src/lib/tasks-collection.ts` |
| Web screen | `apps/agent-web/src/pages/HomePage.tsx` (the Captures create+list model) |
| Mobile REST | `fetchTasks`/`addTask` in `apps/agent-mobile/src/lib/api.ts` |
| Mobile singleton | `apps/agent-mobile/src/lib/captures-collection.ts` (has `setCapturesTokenGetter`; Task has no mobile singleton yet) |
| Mobile hook | `apps/agent-mobile/src/lib/use-captures-api.ts` (Task has none yet) |
| Mobile screen | `apps/agent-mobile/src/app/(signed-in)/index.tsx` (Captures) |
| Mobile tab | `apps/agent-mobile/src/app/(signed-in)/_layout.tsx` |

Client rows carry a **client-minted UUID `id`** the server persists verbatim: the
primary key, the dedupe key for offline replay, and the reason optimistic rows
never flicker.

## Key A1 decisions

### Ship the full table in migration 0046, wire only add + list

The parent plan numbers exactly one migration (`0046`) carrying the whole shape,
and treats A2 as adding the `setStatus` verb, the route, and the list-scoping —
**not** a new migration. So A1 creates the full `projects` table now (all five
columns plus the partial index) and adds only the `add`/`list` behavior on top.
This avoids an `ALTER TABLE` in A2 and matches the append-only migration
convention.

- Columns: `id` (TEXT PK), `title` (TEXT NOT NULL), `icon` (TEXT NOT NULL),
  `description` (TEXT, nullable), `status` (TEXT NOT NULL DEFAULT `'next'`),
  `createdAt` (TEXT NOT NULL). Mirror `0043_tasks.sql`.
- Partial index `projects_open ON ("createdAt") WHERE status != 'done'` (mirrors
  `tasks_open`; keeps a future large `done` pile out of the index). It is
  harmless in A1 where every row is `next`.
- `icon` and `status` are **NOT NULL with defaults** so `add(title)` never has to
  supply them; `description` is nullable and defaults to `null`. `icon` stays a
  plain string column so the representation can later evolve (emoji → SF
  Symbols) with no migration.

### The `Project` type carries all fields; A1 only writes title

`add(id, title, opts?)` applies defaults locally and server-side: icon `📁`,
description `null`, status `next`. The returned `Project` shape is complete
(`id`, `title`, `icon`, `description`, `status`, `createdAt`) so the list can
render `📁` + title and A2/A3 need no type change. A1 renders only the icon and
title; status is stored but has no UI.

### Default status `next` (tracked open question)

`status` is NOT NULL, so A1 needs a create default. Use `next` — the parent's
recommendation (visible, one step from Active, matches "I'm adding this to do
it"). This is still open question 1 in the parent plan; `next` is the working
default until it resolves.

### List returns all rows, ordered `createdAt` ascending

A1 has no status transitions, so every row is `next` and the list is flat.
`list()` returns all projects oldest-first (like `DbTaskStore.list()` minus the
`completedAt` filter). A2 introduces `setStatus` and re-scopes `list()` to
non-`done` plus the grouped sections. Do not scope by status in A1 — there is
nothing to scope yet.

## What to build, layer by layer

### Server (`apps/agent-api`)

- **`src/UserDO/db/migrations/0046_projects.sql`** — `CREATE TABLE projects` with
  the six columns above and the `projects_open` partial index. Copy the header
  comment style from `0043_tasks.sql`.
- **`src/UserDO/db/migrations.ts`** — `import m0046 from
  "./migrations/0046_projects.sql";` and add `m0046` to the `migrations` map.
- **`src/UserDO/db/schema.ts`** — add the `projects` do-orm table mirroring
  `tasks`, with `icon`/`status` as `column.text().notNull()` (status
  `.default("next")`) and `description` nullable.
- **`src/store/projects.ts`** — `DbProjectStore` and a `Project` interface.
  Methods for A1: `add(id, title, opts?)` (dedupe on `id` like `DbTaskStore.add`;
  apply defaults icon `📁` / description `null` / status `next` when `opts`
  omits them) and `list()` (all rows, `createdAt` asc). A `toProject` row
  projector like `toTask`. Leave `setStatus`/`edit` for A2/A3.
- **`src/UserDO/index.ts`** — construct `this.projects = new
  DbProjectStore(this.db)` and expose `addProject(id, title, opts?)` and
  `listProjects()` pass-throughs (mirror `addTask`/`listTasks`).
- **`src/routes/projects.ts`** — `createProjectsRoutes` (OpenAPIHono + zod),
  mirroring `createTasksRoutes`:
  - `GET /api/projects` → `200 { projects }`.
  - `POST /api/projects { id, title, icon?, description?, status? }` →
    `201 { project }`. Body zod: `id` `.uuid()`, `title` `.min(1)`, the rest
    optional. `400` on empty title or non-UUID id. The client normally sends only
    `id` + `title`; the server fills defaults.
  - Log `project_added`.
- **`src/app.ts`** — `import { createProjectsRoutes }` and
  `app.route("/", createProjectsRoutes())` next to the tasks mount.

### Shared data layer (`packages/agent-core/src/projects/`)

- **`types.ts`** — the `Project` type (all six fields) and a `ProjectStatus`
  union (`"active" | "next" | "waiting" | "backlog" | "done"`). Define the union
  now so A2 reuses it; A1 only ever writes `next`.
- **`collection.ts`** — sibling of `tasks/collection.ts`, A1 subset:
  - `ProjectsRest` = `{ fetchProjects, addProject }`.
  - `ProjectsApi` = `{ collection, add, offline, refetch, getLoadError,
    subscribeLoadError }`. `add(title)` only.
  - `createInMemoryProjectsApi`, `createPersistedProjectsApi`,
    `createProjectsApi`, and the pure `projectsReconcileWrites` (identical diff
    to `tasksReconcileWrites`: insert/update present rows, delete keys the server
    dropped).
  - **Reuse** `StartOfflineExecutor` / `WarnFn` from `../captures/collection`.
  - `optimisticProject(title)` mints `safeRandomUUID()` id and the same defaults
    the server applies (icon `📁`, description `null`, status `next`, `createdAt`
    now), so the optimistic row matches the server row exactly — no temp-to-real
    swap, no flicker.
  - Constants: collection id `"projects"`, `PROJECTS_QUERY_KEY = ["projects"]`,
    outbox mutation fn name `addProject`. Copy the readiness/flicker mechanics
    (markReady-from-snapshot, reconcile after each REST call before the
    optimistic overlay drops) verbatim from `tasks/collection.ts`.
- **`view.ts`** — `projectsView({ count, isLoading, loadError })` →
  `"rows" | "loading" | "empty" | "error"`, identical rule to `todayView`.
- **`index.ts`** — export `Project`, `ProjectStatus`, `PROJECTS_QUERY_KEY`,
  `createProjectsApi`, `createInMemoryProjectsApi`, `createPersistedProjectsApi`,
  `projectsReconcileWrites`, `ProjectsApi`, `ProjectsRest`, `projectsView`,
  `ProjectsView`.

`sections.ts` (`projectsByStatus`) is **A2**, not A1.

### Web (`apps/agent-web`)

- **`src/lib/projects.ts`** — same-origin REST `fetchProjects()` +
  `addProject(project)`, mirroring `lib/tasks.ts`. Re-export `Project`.
- **`src/lib/projects-collection.ts`** — OPFS-persisted singleton
  `getProjectsApi()`, mirroring `lib/tasks-collection.ts`. Import the shared
  module `queryClient` from `./captures-collection` and `getAppPersistence` from
  `./db`; pass `{ fetchProjects, addProject }`.
- **`src/pages/ProjectsPage.tsx`** — mirror `HomePage.tsx`'s structure
  (`*Panel` loads the api, `*Ready` runs the `useLiveQuery`), but simpler:
  - A `useLiveQuery` over the collection ordered by `createdAt` asc (no
    `where` — A1 lists all).
  - A **name-only create**: reuse `ui/input` in a small form. Submit on Enter →
    `api.add(title)`, clear, keep focus (like the Captures quick-add). Surface a
    write error via `tx.isPersisted.promise`. Create disabled/no-op on empty
    title.
  - **Persistent one-line helper below the field** teaching outcome-based naming
    (measurable, observable — e.g. "Name the outcome you'll reach, so you know
    when it's done"). Helper text, **not** the placeholder (a placeholder is not
    a label). The placeholder may hold one short example (e.g. "Run a 5K under 30
    min").
  - Flat list, `projectsView`-gated on row count (copy the `useDelayed`
    loading-text pattern from `HomePage`). Each row: `📁` icon + title,
    display-only (no status badge, no controls — those are A2/A3).
  - Refetch on `visibilitychange` like Captures.
- **`src/App.tsx`** — `import { ProjectsPage }` and add `<Route path="projects"
  element={<ProjectsPage />} />` inside `AppShell` (unlinked from marketing, like
  `/captures`).
- **`src/components/SideNav.tsx`** — add a `Projects` entry to `NAV_ITEMS` with a
  folder icon (add a `FolderIcon` next to `InboxIcon`/`CalendarIcon`).

### Mobile (`apps/agent-mobile`)

- **`src/lib/api.ts`** — already has `fetchTasks`/`addTask` (lines ~180+). Add
  `fetchProjects(getToken)` and `addProject(getToken, project)` in the same
  Bearer style. `Project` is already importable from `@zero/agent-core`; re-export
  it beside `Capture`/`Task`.
- **`src/lib/projects-collection.ts`** — the op-sqlite + shared-outbox singleton
  with `setProjectsTokenGetter`, mirroring `captures-collection.ts`
  (`getMobileProjectsApi`, `resetProjectsApiForTest`, `makeRest`). Reuse
  `getAppOutbox`/`getAppPersistence` from `./db`.
- **`src/lib/use-projects-api.ts`** — the hook, mirroring `use-captures-api.ts`:
  set the token getter each render, resolve the singleton once.
- **`src/app/(signed-in)/projects.tsx`** — a flat list screen mirroring the
  Captures screen minus reorder/swipe/edit: a `FlatList` (or `SectionList`
  without sections in A1) rendered from the `useLiveQuery`, `projectsView`-gated,
  each row `📁` + title, plus the name-entry. Reuse the existing `QuickAdd`
  (`components/quick-add.tsx`) / `ui/fab.tsx` for name entry with the same helper
  text. On submit: optimistic `api.add(title)`, keep the bar open and cleared.
- **`src/app/(signed-in)/_layout.tsx`** — add a third `NativeTabs.Trigger
  name="projects"` with `sf="folder"`, `md="folder"`, label `Projects`.
  **Native change: needs a fresh EAS dev build to appear on device** (pure-JS
  reload will not show the new tab).

## Tests

Follow the repo's actual split (the parent plan conflates them):

- **`apps/agent-api/src/store/projects.test.ts`** — the **real** do-orm store over
  `createMockStorage` (copy `store/captures.test.ts`'s `makeStore`). Assert:
  `add` returns the row with defaults (icon `📁`, description `null`, status
  `next`); a replayed id returns the stored row (no second insert); `add` with
  explicit fields persists them; `list()` returns rows oldest-first; empty store
  lists empty.
- **`apps/agent-api/src/routes/projects.test.ts`** — the HTTP contract over a
  **fake UserDO** array stand-in (copy `routes/captures.test.ts`). Assert: `POST`
  from `id` + `title` returns `201` with defaults; `400` on empty title and on a
  non-UUID id; `GET` returns `{ projects }`.
- **`packages/agent-core/src/projects/collection.test.ts`** — `projectsReconcileWrites`
  (insert/update/delete diff), copied from `tasks/collection.test.ts`.
- **`packages/agent-core/src/projects/view.test.ts`** — `projectsView` table, copied
  from `tasks/view.test.ts`.
- **`apps/agent-mobile/src/app/(signed-in)/__tests__/projects.test.tsx`** — a jest
  screen test mirroring `__tests__/index.test.tsx`: render the list, open the
  name entry and submit → `api.add`, an empty name disables/no-ops create. The
  op-sqlite path falls back to in-memory under jest, so no native mock is needed.

Cannot run `workerd` on this box, so no local full-worker run. Verify with:
`pnpm --filter @zero/agent-api test`, `pnpm --filter @zero/agent-core test`,
`pnpm --filter @zero/agent-mobile test`, and `typecheck` + `lint` on
`@zero/agent-api`, `@zero/agent-core`, `@zero/agent-web`, `@zero/agent-mobile`.
On-device Maestro (create a project, see it listed) runs in the Mobile E2E
workflow / on the Pixel 7 after an EAS dev build with the new tab.

## Docs + changelog (same PR)

- **Create `docs/entities/project.md`** following `docs/entities/task.md`'s
  structure (What it is / Vocabulary / Data shape / Behavior / Interactions per
  system / Next). Document status/icon/description as present in the data but
  UI-deferred to A2/A3, and the intended **Task → Project** link (`projectId` on
  `tasks`) under "Next" as deferred to slice B.
- **Update `docs/todo-app.md`** — Project entity: draft → building (#3, A1
  landed); note the Rule-of-Three extraction as the tracked follow-up after A3.
- **Update `docs/plans/todo-project-entity.md`** — mark A1 shipped.
- **Changelogs** (user-facing, same change): `apps/agent-web/CHANGELOG.md` (web
  `/projects` can create and list projects) and `apps/agent-mobile/CHANGELOG.md`
  (a Projects tab: create and list projects, offline-safe). From the user's
  perspective, no internals. Load the `changelog` skill before editing.

## Acceptance criteria

- Create a Project by entering **only a name** on web (`/projects`) and mobile;
  it appears in the flat list with the default `📁` icon, ordered oldest-first.
- The create field shows **outcome-naming guidance as helper text** below it (not
  the placeholder).
- The Project persists across reload and syncs; mobile creation works **offline**
  (outbox replays) with **no duplicate** on a replayed client id.
- The web `Projects` nav entry and the mobile `Projects` tab are present (mobile
  tab requires a fresh dev build to appear on device).
- Store, route, agent-core reconcile/view, and mobile screen tests are green;
  `typecheck` and `lint` pass for all four packages.
- `docs/entities/project.md` exists; `docs/todo-app.md` and the parent plan are
  updated; both changelogs carry a user-facing entry.
- No status UI, no detail sheet, no AI (A2/A3 and later slices).

## Skills to use

- `vocabulary` — keep module/interface/seam/adapter terms consistent.
- `deep-modules` — the do-orm store is a **local-substitutable** dependency
  (real SQLite in the store test); keep the collection factory a deep module
  behind `ProjectsApi`.
- `tdd` — the server store/routes and the pure agent-core helpers are natural
  red-green.
- `expo-ui` / `expo-router` — the mobile name entry and the new tab.
- `impeccable` — polish the web Projects list and create field.
- `changelog` — before editing either CHANGELOG.
- `git-commit` — commit code + docs + changelog together.
- `reproducible-locally` — package tests + typecheck + lint here; on-device
  Maestro after an EAS build; post-deploy check.

## Risks

- **New native tab needs a fresh dev build** before on-device runs; a pure-JS
  reload silently omits it. Build a dev client before Maestro.
- **Third full sibling adds duplication** (Capture/Task/Project). Intentional and
  bounded; the Rule-of-Three extraction follow-up removes it after A3, before
  slice B. Do not extract mid-A1.
- **This box cannot run `workerd`** — no local end-to-end. Verify per-package and
  post-deploy.
