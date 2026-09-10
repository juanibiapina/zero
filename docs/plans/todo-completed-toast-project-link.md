# Task-completed toast links to the task's project

## Goal

On the mobile todo app's **Home** screen, completing a task that belongs to a
project shows the "Completed" Undo snackbar **with the project named in it and a
tappable link that opens that project's own screen**. The link deep-links across
the tab boundary straight to `/projects/:id`, with the bottom tab bar still
visible and Back returning to the Projects list. Completing a loose task (no
project) is unchanged: "Completed" + Undo, no project line, no link.

## Background

### Where the completion toast is raised

Task completion on mobile goes through the shared, React-free helper
`undoableAction` (`packages/agent-core/src/toast/undoable.ts`). It commits the
optimistic verb, then raises **one** snackbar keyed with the fixed id `"undo"`
(so a second completion replaces the first — only one Undo is ever on screen)
whose single `action` is "Undo", running the inverse verb. Both the act and the
undo route their persist failure to the caller's `onError`.

Three mobile surfaces call it, but only one is in scope here:

- **Home** (`apps/agent-mobile/src/app/(signed-in)/index.tsx`, `TasksTop.onComplete`)
  completes **tasks**, which carry a `projectId`. This is the surface that
  changes. `TasksTop` already receives `projects` (it derives each row's project
  icon via `iconOf`) and `item.projectId`, so the project is already in scope.
- **Upcoming** (`upcoming.tsx`) completes **captures**, which have no project —
  out of scope, unchanged.
- **Project detail** (`projects/[id].tsx`) completes a project's tasks while the
  user is already on that project's screen — a link back to it is redundant, so
  out of scope, unchanged.

### The toast model carries one tappable today

The headless toast controller (`packages/agent-core/src/toast/controller.ts`)
is a deep module behind a small interface: it owns id minting, replacement by
id, timers, and capping. A `Toast` today carries `message`, optional
`description`, and **one** optional `action` (`{ label, onPress }`). Two renderer
adapters paint the snapshot and wire the action: mobile
(`apps/agent-mobile/src/components/toaster.tsx`) and web
(`apps/agent-web/src/components/Toaster.tsx`). Each renders the single `action`
as a button on the right that fires `onPress` then dismisses the toast.

The completion toast needs **two** tappables — the project link and Undo — so the
model must carry a second one.

### Cross-tab deep link works, verified on device (2026-09-10)

Earlier code believed a deep link from the Home tab into a Projects-tab child
route (`/projects/:id`) was blocked by a NativeTabs bug (expo/expo#45786) and so
retreated to opening the `/projects` list. That belief was wrong for our stack.
The real cause was a missing anchor: the Projects stack never declared its first
screen, so a cross-tab push popped back to the list.

Expo Router's "Common navigation patterns" doc prescribes the fix for native
tabs: give the tab's stack `unstable_settings = { initialRouteName: 'index' }`
and navigate with `withAnchor`. Then the detail pushes on top of the list, the
list sits beneath it, the **bottom tabs stay visible**, and **Back returns to the
list**.

This was verified on the real Pixel 7 (expo 57.0.16, NativeTabs): with
`initialRouteName: 'index'` on `projects/_layout.tsx` and
`router.navigate('/projects/:id', { withAnchor: true })`, tapping a link from the
Home tab landed on the exact project's detail screen, the tab bar stayed visible,
and Back popped to the Projects list. Bug 45786 does not bite with the anchor.

Two changes from that spike are already in the working tree and are part of this
plan:

- `projects/_layout.tsx` now sets `export const unstable_settings = { initialRouteName: 'index' }`.
- The Home "Project created" toast's **View** action now deep-links
  `router.navigate('/projects/${id}', { withAnchor: true })` instead of opening
  the `/projects` list.

## Approach and alternatives

**Toast model: add an optional second tappable, additively.** Add
`link?: ToastAction` to `ToastInput` and `Toast` (a secondary, navigation-style
tappable rendered to the **left** of the primary `action`, so Undo keeps its
current rightmost position). `undoableAction` gains optional `description?` and
`link?` params and forwards them. This is backward-compatible: every existing
caller and test that reads `toast.action` (Undo stays in `action`) is unchanged;
only new fields and new tests are added.

- *Alternative — replace `action` with `actions: ToastAction[]`.* The "honest"
  model (a snackbar carries N tappables), but it breaks every reader of
  `toast.action` across both renderers, both toaster tests, `undoableAction` and
  its test, and the existing "Project created" caller — wide churn for a
  two-tappable case that never needs three. Rejected for blast radius and
  back-compat.
- *Alternative — make `description` tappable.* Conflates "describe" with
  "navigate" and still needs a per-toast flag. Rejected.

**Navigation: deep-link to `/projects/:id` with `withAnchor`** (the verified
approach above), not the `/projects` list. The project link and the
already-upgraded "Project created" View both use it.

## What to change and why

1. **`packages/agent-core/src/toast/controller.ts`** — add `link?: ToastAction`
   to both `ToastInput` and `Toast`, and copy it into the `next` toast in `show`
   (alongside `action`). Update the type comments to say a toast may carry a
   primary `action` and a secondary navigation `link`.

2. **`packages/agent-core/src/toast/undoable.ts`** — extend the `undoableAction`
   options with optional `description?: string` and `link?: ToastAction`, and
   forward both into the `toast(...)` call it already makes (keeping the fixed
   `id: "undo"` and the Undo `action`). No behavior change when they are omitted.

3. **`apps/agent-mobile/src/components/toaster.tsx`** — in `ToastRow`, render
   `toast.link` (when present) as a tappable to the left of the existing
   `action`, styled as a secondary link, firing `link.onPress` then dismissing
   the toast (same press contract as `action`). Keep the single-`action` layout
   intact for toasts with no link.

4. **`apps/agent-web/src/components/Toaster.tsx`** — render `toast.link` the same
   way for renderer parity, so the shared model field is not silently unpainted
   on one surface. Web has no caller passing `link` yet, so web behavior is
   unchanged; this is defensive parity only.

5. **`apps/agent-mobile/src/app/(signed-in)/index.tsx`** — in `TasksTop.onComplete`,
   look up the completed task's project from the `projects` prop
   (`item.projectId ? projects.find(p => p.id === item.projectId) : undefined`).
   When found, pass to `undoableAction` a `description` naming the project (its
   icon glyph + title, matching the row badge) and a
   `link: { label: 'Open', onPress: () => router.navigate('/projects/${project.id}', { withAnchor: true }) }`.
   When the task is loose (no project), pass neither, preserving today's toast.
   Add `projects` to the `onComplete` `useCallback` deps (`router` is a stable
   module import).

6. **`apps/agent-mobile/src/app/(signed-in)/projects/_layout.tsx`** — keep the
   `unstable_settings = { initialRouteName: 'index' }` anchor (already added in
   the spike) so the cross-tab deep link lands and the tab bar stays visible.

7. **Home "Project created" View** (`index.tsx`) — keep the spike's upgrade from
   `router.navigate('/projects')` to
   `router.navigate('/projects/${id}', { withAnchor: true })`, so creating a
   project from Home now opens that project directly.

## Out of scope

- **Web app link behavior** (`apps/agent-web` HomePage). The agent-core change is
  designed to serve it later, but wiring web's completed toast to link to the
  project — and its `apps/agent-web/CHANGELOG.md` entry — is a separate decision.
  This plan only adds the harmless render parity in the web renderer.
- **Upcoming** (completes captures, no project) and **Project detail** (already on
  the project) completions — unchanged.
- Any change to the fixed single-`undo`-id replacement rule, timers, or capping.

## Tests to add or update

- **`packages/agent-core/src/toast/undoable.test.ts`** — add a case: passing
  `description` and `link` puts them on the shown toast (`snap[0].description`,
  `snap[0].link?.label`), the Undo `action` is still present, and pressing the
  link fires its `onPress`. Existing cases (no link/description) stay green
  unchanged.
- **`apps/agent-mobile/src/components/__tests__/toaster.test.tsx`** — add a case:
  a toast with both `link` and `action` renders both labels, and pressing the
  link fires its `onPress` and dismisses the toast. The existing single-action
  cases are unaffected.
- **`apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx`** — extend
  the completion tests: completing a **project** task shows a "Completed" toast
  whose `description` names the project and whose `link` deep-links
  `/projects/<projectId>` with `withAnchor` (assert via the existing
  `mockNavigate`); completing a **loose** task shows "Completed" with **no**
  `link`. Update the "Project created" test (it currently asserts
  `mockNavigate('/projects')`) to assert the new
  `('/projects/<id>', { withAnchor: true })` deep link. The existing "offers Undo"
  and "only one Undo toast" assertions (reading `snap[0].action`) stay valid.

Run with the mobile jest config; on the `mini` box use `jest --runInBand` and
stop Metro/gradle first (see `apps/agent-mobile/README.md`). Run agent-core tests
with `pnpm --filter @zero/agent-core run test`.

## Docs to add or update

Add to `apps/agent-mobile/CHANGELOG.md` (most recent first), from the user's
view, two entries covering the shipped behavior:

- `YYYY-MM-DD: Completing a task that belongs to a project now names the project
  in the "Completed" bar and gives you a one-tap Open that jumps straight to that
  project, next to Undo.`
- `YYYY-MM-DD: The View link after creating a project (and links into a project
  from elsewhere) now open the project's own screen directly, with the tab bar
  still there and Back returning to the list.`

## Skills to use

- `tdd` — write the failing agent-core, toaster, and Home tests first (red), then
  extend the model, renderer, and caller (green).
- `changelog` — load before editing `apps/agent-mobile/CHANGELOG.md`.
- `git-commit` — commit the agent-core change, both renderers, the Home caller,
  the projects-stack anchor, the tests, and the changelog together.

## Acceptance criteria

- Completing a project task on Home shows "Completed" with the project named and a
  tappable Open beside Undo; tapping Open lands on that project's own detail
  screen with the tab bar visible and Back returning to the Projects list; Undo
  still reopens the task.
- Completing a loose task on Home shows "Completed" + Undo with no project line and
  no link, exactly as today.
- Only one completion toast is ever on screen (the fixed `"undo"` id replacement is
  preserved); a second completion replaces the first, link and all.
- Creating a project from Home and tapping View opens that project's own screen
  directly (verified on device in the spike).
- Web toast behavior is unchanged; the web renderer paints a `link` if one is ever
  supplied.
- `pnpm --filter @zero/agent-core run test`, plus the mobile jest, lint, and
  typecheck, pass.
- Verified on the real Pixel 7 per the mobile testing rule in the repo AGENTS.md:
  complete a project task and a loose task; confirm Open appears only for the
  project task, opens the exact project with tabs visible and Back to the list,
  and Undo still works. The dev client defaults to the production API, so restore
  any task you reopen/complete during the check.
- `apps/agent-mobile/CHANGELOG.md` has the new user-facing entries, committed with
  the change.
