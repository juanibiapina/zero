# Slice A3 — Project enrich: edit in the sheet (web + mobile) — SHIPPED

> **State:** implemented. Server (`edit` store verb, widened `PATCH`), agent-core
> (`api.edit`, changed-field disambiguation), web, and mobile all in place. Store,
> route, agent-core collection, and mobile screen tests are green; `typecheck` +
> `lint` pass on `@zero/agent-api`, `@zero/agent-core`, `@zero/agent-web`,
> `@zero/agent-mobile`. Mobile text entry is verified on-device (Maestro) after an
> EAS dev build, since the `@expo/ui` `TextInput` is native and does not run under
> jest (the unit test mocks the six `@expo/ui` controls the sheet uses). Slice A
> is complete; the Rule-of-Three extraction is the next change.

Detailed implementation plan for **slice A3** of `docs/plans/todo-project-entity.md`
(itself slice A of `docs/plans/todo-capture-to-project-ai.md`). A1 and A2 are
**shipped** (commits `807e8d7`, `d0ed68e`). A3 is the last slice of A: it lets the
user **edit a project's icon, title, and description** from the detail bottom
sheet that A2 already built. No AI, no Task-in-Project (later slices).

Read the parent plan (`docs/plans/todo-project-entity.md`) for the full slice-A
design and the sibling pattern; read `docs/entities/project.md` for the entity's
source of truth. This document carries only what A3 lands and the concrete files
to touch.

## Goal

A user taps a project row, and in the same detail sheet A2 built — currently
holding only a Status group — they now **change the emoji icon** (from a curated
picker), **rename the project** (an editable title field), and **add a sentence
of intent** (an editable description field). Every edit persists and syncs
offline, exactly like the status change. Ships on **both** web (`/projects`) and
mobile.

The data already supports this: `icon` and `description` are columns on the
`projects` table with defaults since A1's migration `0046`, so **A3 needs no
migration** — only the `edit` verb (store → route → collection) and the sheet UI.

## What A1 + A2 already shipped (the foundation A3 builds on)

- **Server:** `projects` table (id, title, icon, description, status, createdAt).
  `DbProjectStore` has `add` / `list` / `setStatus`. Routes: `GET /api/projects`,
  `POST /api/projects`, `PATCH /api/projects/{id}` (carries only `{ status }`
  today). UserDO exposes `addProject` / `listProjects` / `setProjectStatus`.
- **Shared (`packages/agent-core/src/projects/`):** `types.ts` (`Project` with
  `icon: string`, `description: string | null`), `collection.ts` (`ProjectsRest`
  = `fetchProjects`/`addProject`/`setProjectStatus`; `ProjectsApi` = `add`/
  `setStatus`; in-memory `onUpdate` handles status only; the persisted path has
  `addProject`/`setProjectStatus` outbox mutationFns), `sections.ts`
  (`projectsByStatus`), `view.ts`.
- **Web:** `lib/projects.ts` (same-origin REST), `lib/projects-collection.ts`,
  `pages/ProjectsPage.tsx` (grouped list + name-only create + the detail
  `Sheet` rendering `StatusGroup`), the generic `components/ui/sheet.tsx`
  (`@radix-ui/react-dialog`, props `{ open, onClose, title, srOnlyTitle?,
  children }`).
- **Mobile:** `lib/api.ts` (`fetchProjects`/`addProject`/`setProjectStatus`),
  `lib/projects-collection.ts`, `lib/use-projects-api.ts`,
  `app/(signed-in)/projects.tsx` (grouped `SectionList` + `QuickAdd` + the detail
  `Sheet` rendering a native `StatusGroup`), the generic `components/ui/sheet.tsx`
  (universal `@expo/ui` `BottomSheet`, props `{ open, onClose, children }`).

The detail sheet is **already a generic, entity-agnostic primitive** on both
surfaces; A3 renders more content inside it and touches the sheet shell not at
all.

## Key A3 decisions

### One `edit` verb, carried by the existing `PATCH /api/projects/{id}`

A2 chose a single `PATCH` on the stable id to carry every field update, wiring
only `{ status }` and leaving a comment that A3 widens the body. A3 does exactly
that: the body becomes `{ status?, title?, icon?, description? }`.

- **`status` stays its own store verb** (`setStatus`) with its own
  `project_status_changed` log — it has terminal semantics (dropping the row from
  the list) that a plain field edit does not, and A2 already wired it end to end.
- **`title` / `icon` / `description` are one new `edit` verb** (`store.edit`,
  `editProject` pass-through, `rest.editProject`, `api.edit`), logged
  `project_edited`.
- The route applies whichever concern the body carries: edit fields via
  `editProject`, then `status` via `setProjectStatus`, returning the latest row.
  In practice each UI edit fires its own `PATCH` with a single concern (the sheet
  calls `api.edit({ icon })`, `api.edit({ title })`, `api.edit({ description })`,
  or `api.setStatus`), but the route stays robust if both are present. `400` when
  the body carries no updatable field; `404` when no row has that id.

### `edit(id, fields)` takes a partial, applies only the present fields

`DbProjectStore.edit(id, { title?, icon?, description? })` updates only the keys
present (do-orm `db.update` with a partial column object), re-reads, and returns
the `Project` or `null` when no row has that id. A name is never blanked
(`title` must be non-empty when present); `icon` must be non-empty when present;
`description` may be set to `null` to clear it. This mirrors
`DbCaptureStore.edit` (single-field) generalized to three fields.

`ProjectsApi.edit(id, fields): Transaction` mints an optimistic update that sets
all provided fields in the row in place (so the sheet reflects the change at
once) and returns the transaction, so the page surfaces a write error via
`tx.isPersisted.promise` — the same contract as `add` / `setStatus`.

### In-memory `onUpdate` disambiguates edit from status by the changed field set

The Project collection backs both `setStatus` and `edit` with one
`collection.update`, exactly as the Captures collection backs process / edit /
reschedule / reorder with one update. Disambiguate in the in-memory `onUpdate` by
**`m.changes`**, not `m.modified` (mirror `captures/collection.ts`): if
`"status" in m.changes` call `rest.setProjectStatus`; otherwise call
`rest.editProject` with the changed subset of `{ title, icon, description }`. The
persisted (offline) path instead keys off the **mutationFn name**, so `edit` gets
its own `editProject` outbox mutationFn and `createOfflineAction`, replaying
offline like `addProject` / `setProjectStatus`. No field disambiguation is needed
on the offline path (the name carries it).

### The sheet gains fields above the Status group; edits keep the sheet open

A2's `onPickStatus` closes the sheet on a status pick (a terminal choice). The
new edit fields are **not** terminal, so they keep the sheet open; the user may
change several before dismissing. The row the sheet edits is derived from the
live collection by id (`selected = list.find(p => p.id === selectedId)`), so an
optimistic edit re-renders both the sheet and the underlying list row live.

- **Icon** — a curated emoji picker (`📁 👶 🎓 🏠 🎬 ✈️ 📚 💼 ❤️ 💪 🧳 🎯`), **not**
  a free emoji keyboard, so it renders identically across platforms (the parent
  plan's emoji-rendering risk). Tapping an emoji fires `api.edit({ icon })`
  immediately and marks the current one.
- **Title** — an editable text field seeded from the project. It commits on blur
  and on submit (Enter), not per keystroke, to avoid a write per character. An
  empty title is rejected (no-op, keep the old name).
- **Description** — an editable multi-line field, the sentence of intent. Commits
  on blur; may be cleared (writes `description: null`). Empty by default.

Order in the sheet (top to bottom): icon picker, title field, description field,
then the existing Status group. Use **local field state seeded on open** for
title/description (a controlled native/DOM input driven straight off the
collection would fight the cursor); write the local value back through `api.edit`
on blur/submit.

**Keyboard caveat (from A2):** a multi-line text field inside a bottom sheet is
the category's classic keyboard-collision pain. The native `@expo/ui` sheet and
the Radix web sheet both handle it acceptably, but **verify on a real device**
when this lands (the simulator's keyboard timing lies).

### Optional merge

A3 is small and A2 already built the sheet. If it reads cleaner, A3 may ship in
the same PR as A2 (the parent plan's "Merge option"). As of this plan A2 is
already on `main`, so A3 is its own slice/PR.

## What to build, layer by layer

### Server (`apps/agent-api`)

- **`src/store/projects.ts`** — add
  `edit(id, fields: { title?: string; icon?: string; description?: string | null }): Project | null`:
  build a partial column object from the present keys, `db.update(projects,
  patch, { where: eq("id", id) })`, re-read via `db.get`, return `toProject(row)`
  or `null`. If `fields` is empty, return the current row unchanged (the route
  already guards the empty-body case). Keep `setStatus` as is.
- **`src/UserDO/index.ts`** — add an `editProject(id, fields)` pass-through next
  to `setProjectStatus`.
- **`src/routes/projects.ts`** — widen the `PATCH /api/projects/{id}` body schema
  to `{ status?: ProjectStatus, title?: string (min 1), icon?: string (min 1),
  description?: string | null }`. Handler:
  - Collect edit fields present (`title` / `icon` / `description`).
  - If none of `{ status, title, icon, description }` are present → `400 { error:
    "no fields to update" }`.
  - If edit fields present → `project = await userDO.editProject(id, editFields)`;
    log `project_edited`.
  - If `status` present → `project = await userDO.setProjectStatus(id, status)`;
    log `project_status_changed`.
  - `404` when the (first) verb returns null. Return `200 { project }` with the
    latest row.
  - Update the route summary/description (it says "Change a project's status").
- **Tests** (`src/store/projects.test.ts`, `src/routes/projects.test.ts`): `edit`
  updates each field and leaves the others; `edit` on an unknown id returns
  `null`; a partial edit (`{ icon }`) does not blank title. Route: `PATCH
  { title }` / `{ icon }` / `{ description }` → `200` with the new value; `PATCH
  { description: null }` clears it; `400` on an empty body and on an empty
  `title`/`icon` (zod `min(1)`); `404` on an unknown id; the existing `{ status }`
  path still works. Exercise the real do-orm store through the route (SQLite runs
  in-test); no mock.

### Shared data layer (`packages/agent-core/src/projects/`)

- **`collection.ts`**:
  - Extend `ProjectsRest` with
    `editProject: (id, fields: { title?; icon?; description? }) => Promise<Project>`.
  - Extend `ProjectsApi` with
    `edit: (id, fields: { title?; icon?; description? }) => Transaction`.
  - Add an `editDraft(fields)` optimistic mutator (assign each present field on
    the draft).
  - In `createInMemoryProjectsApi`'s `onUpdate`: branch on `"status" in
    m.changes` → `rest.setProjectStatus` (existing) : else build the changed
    subset from `m.changes` and call `rest.editProject`, then `reconcile` the
    returned row (upsert; an edit never removes the row).
  - In `createPersistedProjectsApi`: add an `editProject` outbox `mutationFn`
    (read the changed fields off `m.modified`, call `rest.editProject`, reconcile
    the returned row) and an `editAction = offline.createOfflineAction<{ id;
    fields }>({ mutationFnName: "editProject", onMutate })`; expose
    `edit: (id, fields) => editAction({ id, fields })`.
  - Mirror the Capture edit path's naming and structure exactly.
- **Tests** (`collection.test.ts`): an `edit` optimistically updates the row and
  the reconcile upserts (not deletes) it; a status change still routes to
  `setProjectStatus`. `projectsReconcileWrites` needs no change (edit keeps the id
  in the list).

### Web (`apps/agent-web`)

- **`src/lib/projects.ts`** — add `editProject(id, fields)` same-origin `PATCH`,
  mirroring `setProjectStatus` (send only the present fields).
- **`src/lib/projects-collection.ts`** — pass `editProject` into the api `rest`.
- **`src/pages/ProjectsPage.tsx`** — in the detail `Sheet`, above `StatusGroup`,
  render:
  - An **emoji picker** row: the curated set as `<button>`s; the current icon
    marked; tap → `commitEdit(id, { icon })`.
  - A **title** `Input` seeded from `selected.title`, committing on blur/Enter →
    `commitEdit(id, { title })` (skip when empty or unchanged).
  - A **description** `<textarea>` (add a minimal `ui/textarea` if none exists, or
    reuse a styled `<textarea>`), seeded from `selected.description ?? ""`,
    committing on blur → `commitEdit(id, { description: value || null })`.
  - A `commitEdit` helper mirroring `commitStatus` (calls `api.edit`, surfaces
    errors via `tx.isPersisted.promise`). Editing does **not** close the sheet;
    only `onPickStatus` does.
- No sheet-shell change; no new nav.

### Mobile (`apps/agent-mobile`)

- **`src/lib/api.ts`** — add `editProject(getToken, id, fields)` (Bearer `PATCH`,
  send only present fields), mirroring `setProjectStatus`.
- **`src/lib/projects-collection.ts`** — pass `editProject` into `makeRest`.
- **`src/app/(signed-in)/projects.tsx`** — inside the sheet, above the native
  `StatusGroup`, add (all `@expo/ui` inside the existing `Column`):
  - An **emoji picker**: the curated set as `@expo/ui` `Button`s (a wrapped
    `Row`/grid), current one marked, tap → `api.edit(id, { icon })`.
  - A **title** `@expo/ui` `TextField` seeded from the selected project,
    committing on blur/submit → `api.edit(id, { title })`.
  - A **description** multi-line `@expo/ui` `TextField`, committing on blur →
    `api.edit(id, { description })`.
  - A `commitEdit` callback mirroring `commitStatus`. Keep the sheet open on
    edit; only status pick dismisses it. The `BackHandler` chain already dismisses
    the sheet first — no change.
  - **React Compiler:** keep the same carry-forward as the rest of the screen
    (derive in the render body / `useMemo`, no memoized gestures).
  - **Native:** the `@expo/ui` `TextField` inside the sheet is a native surface;
    if it is the first `TextField` used in the app it needs a **fresh EAS dev
    build** to appear on device (a pure-JS reload silently omits it). Build a dev
    client before the Maestro run.
- **Tests** (`src/app/(signed-in)/__tests__/projects.test.tsx`): extend the A2
  screen test — open a row's sheet, edit the title → `api.edit` called with
  `{ title }`; tap an emoji → `api.edit` with `{ icon }`; the status pick still
  works and still dismisses. Mock `@expo/ui` `TextField`/`Button` as passthroughs
  as needed (the `BottomSheet` is already mocked).

## Tests

- **`apps/agent-api/src/store/projects.test.ts`** — `edit` updates title / icon /
  description independently, leaves untouched fields, returns null on an unknown
  id; `description: null` clears.
- **`apps/agent-api/src/routes/projects.test.ts`** — `PATCH { title }` / `{ icon }`
  / `{ description }` → `200`; `{ description: null }` clears; `400` empty body and
  empty title/icon; `404` unknown id; the `{ status }` path unchanged.
- **`packages/agent-core/src/projects/collection.test.ts`** — an `edit`
  optimistically updates and reconcile-upserts the row; a status change still
  routes to `setProjectStatus`.
- **`apps/agent-mobile/src/app/(signed-in)/__tests__/projects.test.tsx`** — edit
  title / icon in the sheet → `api.edit`; status pick unchanged.
- **On-device:** a Maestro flow (open a project's sheet → change its icon and
  title → they persist) in the Mobile E2E workflow / on the Pixel 7, after an EAS
  dev build if the sheet `TextField` is new native surface.

This box **cannot run `workerd`**, so no local full-worker run. Verify with `pnpm
--filter @zero/agent-api test`, `pnpm --filter @zero/agent-core test`, `pnpm
--filter @zero/agent-mobile test`, and `typecheck` + `lint` on `@zero/agent-api`,
`@zero/agent-core`, `@zero/agent-web`, `@zero/agent-mobile`. GitHub Actions CI
runs the same across the monorepo; on-device Maestro after the EAS build; a
post-deploy check once `zero-api` auto-deploys.

## Docs + changelog (same PR)

- **`docs/entities/project.md`** — move A3 from "next" to shipped: the sheet now
  edits icon (curated picker) / title / description; document the `edit` verb and
  the widened `PATCH` body alongside `setStatus`.
- **`docs/todo-app.md`** — Project A3 landed (enrich in the sheet); the entity
  wiki Project bullet drops the "enrichment follows in A3" caveat; the
  Rule-of-Three extraction becomes the immediate tracked follow-up (slice A is now
  complete). (That extraction has since shipped, #66.)
- **`docs/plans/todo-project-entity.md`** — mark A3 shipped (as A1/A2 are).
- **Changelogs** (user-facing, same change; load the `changelog` skill first):
  `apps/agent-web/CHANGELOG.md` and `apps/agent-mobile/CHANGELOG.md` — the user
  can now give a project an icon, rename it, and add notes from its detail sheet.
  From the user's perspective, no internals. **Not** `apps/agent-api/CHANGELOG.md`
  (that ships to Zero-assistant users).

## Acceptance criteria

- On **both** web (`/projects`) and mobile, tapping a project row opens the detail
  sheet, which now shows — above the Status group — an **emoji picker** (curated
  set, current one marked), an editable **title** field, and an editable
  **description** field.
- Changing the icon, title, or description writes optimistically, keeps the sheet
  open, and the change is reflected in the row live; a write error surfaces like
  the status change.
- Edits **persist across reload and sync**; a mobile edit works **offline** (the
  outbox replays `editProject`) with no lost or duplicated update.
- An empty title is rejected (the old name stays); the description may be cleared.
- Store, route, agent-core collection, and the mobile screen tests are green;
  `typecheck` + `lint` pass on all four packages.
- `docs/entities/project.md`, `docs/todo-app.md`, and the parent plan are updated;
  both web + mobile changelogs carry a user-facing entry.
- No AI and no Task-in-Project (later slices). Slice A (the Project entity, hand-
  managed) is **complete**; the Rule-of-Three extraction shipped after it (#66),
  and slice B (Task-under-Project) is the next tracked change.

## Skills to use

- `vocabulary` — keep module/interface/seam/adapter terms consistent.
- `deep-modules` — the do-orm store stays a local-substitutable dependency (real
  SQLite in the store test); keep the collection factory a deep module behind
  `ProjectsApi`.
- `tdd` — the `edit` store/route and the collection disambiguation are natural
  red-green.
- `expo-ui` — the mobile sheet `TextField`s and the emoji-picker `Button`s.
- `expo-animation` — only if the new fields need any in-sheet motion (likely
  none).
- `impeccable` — polish the web sheet fields and the emoji picker layout.
- `changelog` — before editing either CHANGELOG.
- `git-commit` — commit code + docs + changelog together.
- `reproducible-locally` — package tests + typecheck + lint here; on-device
  Maestro after an EAS build; post-deploy check.

## Risks

- **Keyboard collision in the sheet** — a multi-line description inside a bottom
  sheet is the classic pain; the native `@expo/ui` and Radix sheets handle it
  acceptably but **verify on device**. Do not switch to `@gorhom/bottom-sheet`
  for this alone.
- **A new native `TextField` needs a fresh dev build** before on-device runs; a
  pure-JS reload silently omits new native surfaces. Build a dev client before
  Maestro.
- **Per-keystroke writes** would spam the outbox — commit title/description on
  blur/submit, not on change; the icon fires once per tap.
- **This box cannot run `workerd`** — verify per-package and post-deploy.
- **Emoji rendering differs across platforms** — ship the small curated, tested
  set, not a free emoji keyboard.

## Follow-up (NOT part of A3) — Rule-of-Three extraction — SHIPPED

With Capture, Task, and Project as three siblings, the shared plumbing was
extracted (the offline collection factory: in-memory + persisted +
reconcile-writes; the `*View` count-gate, now one `listView`; the
id/createdAt/dedupe conventions and the per-surface wiring) — **never** the
domain verbs (`process` / `complete` / `setStatus` / `edit`). Merged to `main` in
#66. Plan: `docs/plans/todo-rule-of-three-extraction.md`. Slice B
(Task-under-Project) is the next tracked change.
