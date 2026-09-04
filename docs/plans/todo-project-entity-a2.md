# Slice A2 — Project status: group + change (web + mobile) — SHIPPED

> **State:** implemented on this branch. Server + agent-core + web + mobile tests
> green; typecheck + lint pass on all four packages. Web verified locally
> (`/projects` on :5176 proxying the worker on :8790): status-grouped sections,
> the Radix detail sheet, status changes re-grouping, and Done + inline Undo.
> **Mobile is not device-verified yet** — the `@expo/ui` `BottomSheet` is native
> and needs a fresh EAS dev build, then a Maestro run on the Pixel 7. Auto-deploys
> to production via the `zero-api` Workers Builds connector on push to `main`
> (agent-web ships as its assets).

Detailed implementation plan for **slice A2** of `docs/plans/todo-project-entity.md`
(itself slice A of `docs/plans/todo-capture-to-project-ai.md`). A1 is **shipped**
(commit `807e8d7`): name-only create + a flat list on both surfaces, with the full
`projects` table (all five statuses, icon, description) already in migration
`0046` but only `add`/`list` wired. A2 makes the **five-status model real**: the
list groups into sections, and the user changes a project's status from a
**tap-to-open detail bottom sheet**.

Read the parent plan (`docs/plans/todo-project-entity.md`) for the full slice-A
design, the Status model, and the rationale behind every decision echoed here.
This document carries only what A2 lands and the concrete files to touch.

## Goal

A user opens a project's **detail bottom sheet** by tapping its row, picks one of
the five statuses (**Active, Next, Waiting, Backlog, Done**) from a Status group,
and the row **re-groups** optimistically into the target section. The Projects
list is **grouped into Active / Next / Waiting / Backlog sections** with counts
and collapse; `done` is excluded from the list. Setting **Done** removes the row
with an inline **Undo (~5s)** so it is never a one-way trap. Ships on **both** web
(`/projects`) and mobile, persisted and offline-safe, with no duplicate on a
replayed write.

A2 does **not** ship title/icon/description editing — that is A3, added to the
same sheet. A2 builds the sheet shell + the Status group only. (A2 and A3 may be
merged into one PR if that reads cleaner; see the parent plan's "Merge option".)

## What A1 already shipped (the foundation A2 builds on)

- **Server:** `projects` table (id, title, icon, description, status DEFAULT
  `'next'`, createdAt) + partial index `projects_open ON (createdAt) WHERE status
  != 'done'` in migration `0046`. `DbProjectStore` has `add` + `list` (list
  currently returns **all** rows oldest-first). Routes: `GET /api/projects`, `POST
  /api/projects`. UserDO exposes `addProject` / `listProjects`.
- **Shared:** `packages/agent-core/src/projects/` — `types.ts` (`Project` +
  `ProjectStatus` union already defined), `collection.ts` (`add`-only
  `ProjectsApi`, `projectsReconcileWrites` — its **delete path already handles a
  row the server drops**, so a `done` project leaving the list needs no new
  reconcile logic), `view.ts` (`projectsView`). Exported from `index.ts`.
- **Web:** `lib/projects.ts` (same-origin REST), `lib/projects-collection.ts`
  (OPFS singleton), `pages/ProjectsPage.tsx` (name-only create + flat list, rows
  are display-only `📁` + title), route + `SideNav` entry.
- **Mobile:** `lib/api.ts` project helpers, `lib/projects-collection.ts`,
  `lib/use-projects-api.ts`, `app/(signed-in)/projects.tsx` (flat `FlatList` +
  `QuickAdd`), third `NativeTabs.Trigger`.

## Key A2 decisions

### `list()` scopes to non-`done`; `done` rows leave the working set

A2 re-scopes `DbProjectStore.list()` to non-`done` rows. `do-orm` exports `ne`,
so use `where: ne("status", "done")` (this is what the `projects_open` partial
index was built for). The other four statuses are the working set the sheet
groups. When a project becomes `done` the server stops returning it, the
collection's existing `projectsReconcileWrites` delete-path drops it, and the row
leaves the list — exactly the mechanic A1 already tests. No "Done" archive view in
A2 (parent open question 3 → inline Undo, below).

### One `setStatus` verb, carried by `PATCH /api/projects/{id}`

Mirror the Captures pattern: a single `PATCH /api/projects/{id}` carries field
updates on a stable id. A2 wires only `{ status }`; A3 widens the same body to
`{ title?, icon?, description? }`. This avoids a second endpoint and matches
`PATCH /api/captures/{id}` (which carries edit + reschedule + reorder). The verb
is **`setStatus`**, not a binary archive — moving between any two of the five
states (including to/from `done`) is one status change.

### Status change lives only in the detail sheet (no per-row control)

Tapping a row opens a slide-up **detail sheet**; the sheet holds a **Status
group** (the five states as selectable rows, current one marked with a checkmark).
Tapping the current status is a no-op; tapping another calls
`api.setStatus(id, next)` and dismisses the sheet. Not a swipe (binary-only) and
not tap-to-cycle (ambiguous across five ordered states). No drag-between-sections
in v1. This removes all hover-only / inline-affordance discoverability risk: the
row is one tap target.

### Build the sheet as a reusable, entity-agnostic primitive

There is **no sheet component in either app today** (`agent-web/components/ui` has
only button/card/input/table; mobile has `confirm-dialog`/`fab`/`input`/`text`,
no `BottomSheet`). A2 builds one, and it must be **generic and reusable**, not a
project-specific sheet — the same way `components/ui/confirm-dialog.tsx` (mobile)
is a content-agnostic overlay driven by props and reused anywhere, and the way
`ui/button`/`ui/input`/`ui/card` are shared primitives. This is a hard design
constraint: **the sheet knows nothing about projects.**

- **The shell is the primitive; the content is passed in.** The sheet component
  owns only presentation and lifecycle: slide-up/dismiss animation, backdrop/scrim,
  an explicit Close (X), `open`/`onClose`, and a `children` (or `content`) slot.
  It takes an optional `title` and renders arbitrary children. The project-specific
  **Status group** is just a component rendered *inside* the sheet, exactly as
  `ConfirmDialog` takes `title`/`message` props rather than baking in one caller.
  A3's title/icon/description fields, Captures Slice 3's edit + scheduler, and any
  future detail/edit UI all render into the **same** shell with no change to it.
**One contract, two implementations.** `agent-web` is a plain Vite + React 19 +
Tailwind app (**not** Expo / react-native-web), and `agent-mobile` is Expo/React
Native, so the two surfaces **cannot share sheet code** — only the prop shape
(`{ open, onClose, title?, children }`). Each app owns a `components/ui/sheet.tsx`
with that same small API. The framework choices below come from researching modern
(2025–2026) practice — see `docs/plans/todo-project-entity-a2.md` research notes /
the `research` skill session; both are the settled, well-supported answers, not a
hand-roll.

- **Web → `@radix-ui/react-dialog` + a Tailwind slide** (`components/ui/sheet.tsx`,
  the shadcn "Sheet" recipe). Radix Dialog is **actively maintained** (same family
  as the `@radix-ui/react-slot` agent-web already depends on) and gives the
  accessibility floor for free — focus moves into the sheet, Esc + backdrop
  dismiss, body scroll-lock, background hidden from screen readers — which a
  hand-rolled sheet reliably gets wrong. Bottom-anchor it with a `data-state`
  open/closed CSS transition (~40 lines). Add only `@radix-ui/react-dialog`; do
  **not** pull in all of shadcn or `@zero/ui`.
  - **Not `vaul`.** It looks like the obvious pick (it's what shadcn's Drawer and
    Expo's own web sheet wrap) but its README now declares it **unmaintained**
    ("not in the near future", last release Dec 2024). It is a thin drag-gesture
    layer over Radix Dialog; a tap-to-open detail sheet does not need drag-to-
    dismiss, so depend on maintained Radix directly and skip vaul.
- **Mobile → the universal `BottomSheet` from `@expo/ui`** (root import), wrapped
  in `components/ui/sheet.tsx`. It renders a real **SwiftUI sheet on iOS** and a
  **Jetpack Compose `ModalBottomSheet` on Android**, delegating gesture/animation
  and the a11y floor to the OS — **not** `@gorhom/bottom-sheet` (needed only for
  scroll-inside-sheet, multiple snap points, or keyboard-heavy forms, none of
  which A2 has) and **not** a hand-rolled Reanimated sheet. Use its
  **`isPresented` / `onDismiss`** props (the gorhom-style `isOpen`/`onChange`
  props silently no-op), and `snapPoints` is optional (auto-sizes to the short
  Status-group content). Prefer the root universal `BottomSheet` over the
  `@expo/ui/community/bottom-sheet` drop-in — the drop-in only earns its keep when
  migrating existing gorhom code, and there is none here. Bump `@expo/ui` to the
  recommended **`~57.0.15`** when touching it (currently `~57.0.13`). Callers
  extend the app's existing `BackHandler` chain so Back dismisses the sheet first.

Because the shell is entity-agnostic, it is **shared with Captures Slice 3**
(`docs/plans/captures-detail-sheet-scheduler-plan.md`, its "NEXT" slice, also
unbuilt) with zero project coupling. Whoever lands first (Projects A2 or Captures
Slice 3) builds each app's primitive; the other reuses it. Keep the API
deliberately small so it survives both callers without per-caller branches.

**A3 keyboard caveat:** A3 adds a multi-line description field inside the sheet;
text input in a sheet is the category's classic keyboard-collision pain. The
native `@expo/ui` sheet and the Radix web sheet both handle it acceptably, but
verify on a real device when A3 lands (the simulator's keyboard timing lies). Not
a reason to pick gorhom now.

### Grouped list: counts, collapse, hide-empty

The list renders the four working statuses as labeled sections via a new pure
`projectsByStatus` helper (sibling of `upcomingSections`). Section headers carry a
**count** ("Backlog · 37") and are **collapsible**; Active + Next expand by
default, Backlog collapses by default when large; **empty sections are hidden**.
Within a group, order by `createdAt` ascending. Fixed section order: Active, Next,
Waiting, Backlog. `done` is never a section in A2.

Collapse state is client-only UI state. Whether it **persists per user** across
opens is parent open question 2 — default to **not persisting** in A2 (reset on
each mount) to keep it a pure render concern; note persistence as a later add.

### Done is the one-way-trap guard: inline Undo (~5s)

Selecting **Done** removes the row from the working list and A2 ships **no Done
view**. To avoid a project vanishing with no way back: after the sheet dismisses,
leave the row **briefly in place, struck-through, with an inline "Undo" (~5s)**
before it animates out; Undo within the window calls
`api.setStatus(id, previousStatus)`. This is a **row-level affordance — no
toast/snackbar component** (there is none in these surfaces). Capture
`previousStatus` at the moment of the change to restore it exactly.

## What to build, layer by layer

### Server (`apps/agent-api`)

- **`src/store/projects.ts`** — add `setStatus(id, status): Project | null`
  (mirror `DbTaskStore.complete`: `db.update(projects, { status }, { where:
  eq("id", id) })`, then re-read and `toProject`, returning `null` when no row).
  Re-scope `list()` to `where: ne("status", "done")` (import `ne` from `do-orm`);
  keep `orderBy: asc("createdAt")`. (A3 will add `edit`.)
- **`src/UserDO/index.ts`** — expose `setProjectStatus(id, status)` pass-through
  next to `addProject` / `listProjects`.
- **`src/routes/projects.ts`** — add a `PATCH /api/projects/{id}` route
  (`OpenAPIHono` + zod), mirroring the captures PATCH shape:
  - Params `{ id }`. Body `{ status?: ProjectStatus }` for A2 (A3 widens to
    `title?/icon?/description?`). Reuse the existing `ProjectStatus` zod enum.
  - `200 { project }` on success; `400` when the body has no updatable field or an
    unknown status (zod rejects a bad enum); `404` when no row has that id.
  - Log `project_status_changed` when `status` changes.
- **Tests** (`src/routes/projects.test.ts`, `src/store/projects.test.ts`): a
  `PATCH { status }` returns `200` with the new status; a `PATCH` to `status:
  "done"` then a `GET` no longer lists the row; `list()` excludes `done`; `404` on
  an unknown id; `400` on an empty body / bad status. Exercise the real do-orm
  store through the route (SQLite runs in-test); no mock.

### Shared data layer (`packages/agent-core/src/projects/`)

- **`sections.ts`** — pure `projectsByStatus(projects)` grouping the four working
  statuses into ordered sections `[{ status, projects }]` (Active, Next, Waiting,
  Backlog fixed order, `createdAt` asc within each, **empty sections omitted**),
  mirroring `captures/upcoming.ts`'s `upcomingSections`. `done` never appears
  (defensive: skip it even if a stray `done` row is passed). Unit-tested in
  isolation.
- **`collection.ts`** — extend `ProjectsRest` with `setProjectStatus(id, status)`
  and `ProjectsApi` with `setStatus(id, status): Transaction`. Add the optimistic
  status-change action in **both** the in-memory and persisted builders (mirror
  the `add` pairing): optimistically update the row's `status` in the collection,
  call `rest.setProjectStatus`, reconcile the server row, and — because a `done`
  row is dropped by the server — let `fetchAndReconcile` / the reconcile
  delete-path remove it. In the persisted builder add a `setProjectStatus` outbox
  `mutationFn` + `createOfflineAction`, so a status change replays offline like
  `add`. Roll back on failure (the collection's optimistic update reverts, the row
  returns to its old section).
- **`index.ts`** — export `projectsByStatus` and its section type.
- **Tests:** `projectsByStatus` (grouping, section order, empty-section omission,
  `done` excluded); the `collection.test.ts` reconcile test already covers the
  delete path — add a case asserting a `setStatus`-to-`done` reconcile removes the
  key.

### Web (`apps/agent-web`)

- **`src/lib/projects.ts`** — add `setProjectStatus(id, status)` same-origin REST
  (`PATCH /api/projects/{id}`), mirroring `lib/captures.ts`'s `reschedule`.
- **`src/lib/projects-collection.ts`** — pass `setProjectStatus` into the api
  `rest`.
- **`src/components/ui/sheet.tsx`** — the **generic, entity-agnostic** slide-up
  sheet shell built on **`@radix-ui/react-dialog`** + a Tailwind `data-state`
  slide (`{ open, onClose, title?, children }`; Radix gives Close/Esc/backdrop
  dismiss, scroll-lock, focus trap). Knows nothing about projects; shared with
  Captures Slice 3. Add `@radix-ui/react-dialog` to `agent-web` dependencies (not
  `vaul` — unmaintained). The Status group is a separate component rendered as its
  `children`.
- **`src/pages/ProjectsPage.tsx`** — replace the flat list with the
  `projectsByStatus` grouped sections (collapsible headers with counts,
  hide-empty, Active/Next expanded, Backlog collapsed-when-large). Row stays
  display-only (`📁` + title, no status badge — the section says the status) and
  is a **single tap target** opening the detail sheet. Sheet contents for A2: a
  **Status group** (five rows, current marked) → `api.setStatus`. On Done: the
  inline struck-through Undo row (~5s) before it animates out. Keep the
  `projectsView` count-gate and the name-only create from A1.
- The re-group animation reuses whatever list layout/exit animation Captures uses
  on web; A2's optimistic write is the trigger (exit-here + enter-there, not a
  literal fly-across).

### Mobile (`apps/agent-mobile`)

- **`src/lib/api.ts`** — add `setProjectStatus(getToken, id, status)` (Bearer
  `PATCH`), mirroring the Task/Capture helpers.
- **`src/lib/projects-collection.ts`** — pass `setProjectStatus` into `makeRest`.
- **`src/components/ui/sheet.tsx`** — the **generic** wrapper over the universal
  `BottomSheet` from `@expo/ui` (root import), mapping `{ open, onClose, children }`
  onto its `isPresented`/`onDismiss` props (auto-sized, no `snapPoints` needed);
  matches the `confirm-dialog` convention; project-agnostic, shared with Captures
  Slice 3. Bump `@expo/ui` to `~57.0.15`.
- **`src/app/(signed-in)/projects.tsx`** — swap the flat `FlatList` for a
  `SectionList` driven by `projectsByStatus` with **sticky collapsible headers**
  (count + collapse chevron; Active/Next expanded, Backlog collapsed when large,
  empty hidden). Tapping a row opens the shared sheet, rendering a **Status group**
  component as its children (current marked → `api.setStatus`). Extend the
  screen's existing `BackHandler` chain so Back dismisses the sheet before closing
  the quick-add or leaving. On Done: the inline Undo row (~5s). Keep the `QuickAdd`
  create from A1.
  - **React Compiler:** call `projectsByStatus` inside `useMemo` in the render
    body; build any gesture inline (no `useMemo`) — the same carry-forward the
    Captures screen follows.
  - **Native:** the `@expo/ui` `BottomSheet` is a native surface → needs a
    **fresh EAS dev build** to appear on device (a pure-JS reload silently omits
    it). Build a dev client before the Maestro run.

## Tests

- **`apps/agent-api/src/store/projects.test.ts`** — `setStatus` updates and
  returns the row; `list()` excludes `done`; `setStatus` on an unknown id returns
  `null`.
- **`apps/agent-api/src/routes/projects.test.ts`** — `PATCH { status }` → `200`;
  `PATCH { status: "done" }` then `GET` omits the row; `400` empty body / bad
  status; `404` unknown id.
- **`packages/agent-core/src/projects/sections.test.ts`** — `projectsByStatus`
  grouping + fixed section order + empty-section omission + `done` excluded.
- **`packages/agent-core/src/projects/collection.test.ts`** — add a `setStatus`
  reconcile case (a row that becomes `done` is removed by the reconcile delete
  path).
- **`apps/agent-mobile/src/app/(signed-in)/__tests__/projects.test.tsx`** — extend
  the A1 screen test: render grouped sections; tap a row → sheet opens; pick a
  status → `api.setStatus` called and the row moves section; set Done → the row
  shows Undo then leaves; Undo → `api.setStatus(id, previousStatus)`. Mock the
  `@expo/ui` `BottomSheet` as a passthrough. The op-sqlite path falls back to
  in-memory under jest, so no native mock is needed.
- **On-device:** a Maestro flow (create a project → open its sheet → change status
  → it re-groups) in the Mobile E2E workflow / on the Pixel 7, after an EAS dev
  build with the `BottomSheet`.

This box **cannot run `workerd`**, so no local full-worker run. Verify with `pnpm
--filter @zero/agent-api test`, `pnpm --filter @zero/agent-core test`, `pnpm
--filter @zero/agent-mobile test`, and `typecheck` + `lint` on `@zero/agent-api`,
`@zero/agent-core`, `@zero/agent-web`, `@zero/agent-mobile`. GitHub Actions CI
runs the same across the monorepo; on-device Maestro after the EAS build; a
post-deploy check once `zero-api` auto-deploys.

## Docs + changelog (same PR)

- **Update `docs/entities/project.md`** — status is now user-facing: the five
  states, the `setStatus` verb, the grouped list, Done-as-terminal + inline Undo.
  Move status from "present but UI-deferred" to shipped.
- **Update `docs/todo-app.md`** — Project entity A2 landed (status grouping +
  change); Rule-of-Three extraction still the tracked follow-up after A3.
- **Update `docs/plans/todo-project-entity.md`** — mark A2 shipped (as A1 is).
- **Changelogs** (user-facing, same change), load the `changelog` skill first:
  `apps/agent-web/CHANGELOG.md` (organize projects by status; change a project's
  status from its detail sheet) and `apps/agent-mobile/CHANGELOG.md` (same, from
  the Projects tab). From the user's perspective, no internals. **Not**
  `apps/agent-api/CHANGELOG.md` (that ships to Zero-assistant users).

## Acceptance criteria

- On **both** web (`/projects`) and mobile, the Projects list is **grouped into
  Active / Next / Waiting / Backlog sections** with counts and collapse; empty
  sections are hidden; `done` is excluded.
- **Tapping a project row opens a detail bottom sheet** with a **Status group**
  (five states, current one marked); Close / Back / Esc dismiss it.
- Picking a status calls `setStatus` and the row **re-groups optimistically** to
  the target section (rollback on write failure).
- Setting **Done** removes the row from the working list with an inline **Undo
  (~5s)** that restores the previous status.
- Changes **persist across reload and sync**; mobile status change works
  **offline** (outbox replays) with no duplicate/incorrect final state.
- Store, route, agent-core (`projectsByStatus` + reconcile), and the mobile screen
  tests are green; `typecheck` + `lint` pass on all four packages.
- `docs/entities/project.md`, `docs/todo-app.md`, and the parent plan are updated;
  both web + mobile changelogs carry a user-facing entry.
- **No title/icon/description editing** (A3) and no AI (later slices). The detail
  sheet ships with the Status group only (unless A2+A3 are merged).

## Skills to use

- `vocabulary` — keep module/interface/seam/adapter terms consistent.
- `deep-modules` — the do-orm store stays a local-substitutable dependency
  (real SQLite in the store test); keep the collection factory a deep module
  behind `ProjectsApi`.
- `tdd` — the `setStatus` route/store and the pure `projectsByStatus` helper are
  natural red-green.
- `expo-ui` — the mobile detail `BottomSheet` and the in-sheet Status group.
- `expo-animation` — the sheet's coexistence with the list and the re-group /
  Done-exit animations.
- `impeccable` — polish the web grouped list, collapsible headers, and sheet.
- `changelog` — before editing either CHANGELOG.
- `git-commit` — commit code + docs + changelog together.
- `reproducible-locally` — package tests + typecheck + lint here; on-device
  Maestro after an EAS build; post-deploy check.

## Risks

- **New native sheet needs a fresh dev build** before on-device runs; a pure-JS
  reload silently omits the `@expo/ui` `BottomSheet`. Build a dev client before
  Maestro.
- **The sheet overlaps Captures Slice 3** — build one shared primitive (web
  `ui/sheet.tsx` + mobile `@expo/ui` wrapper); if Captures Slice 3 lands first,
  reuse its sheet. Sequence with whoever touches the sheet first.
- **This box cannot run `workerd`** — no local end-to-end; verify per-package and
  post-deploy.
- **Backlog turning into ignored "garbage"** — Backlog stays a collapsed, counted
  section, out of the way; the create default remains `next` (visible) so new work
  does not sink into it.
- **Third full sibling adds duplication** — intentional and bounded; the
  Rule-of-Three extraction follow-up (after A3) removes it before slice B. Do not
  extract mid-A2.
