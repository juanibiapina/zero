# Add a waiting condition with the "+" affordance, not an inline form

## Goal

On the project detail screen, add a waiting condition through the app's "+"
compose affordance instead of an always-present inline form, on both mobile and
web. This mirrors the task-add rework (`docs/plans/todo-project-task-add-fab.md`,
shipped): the project screen's task composer already moved from an inline field
to the shared plus-FAB quick-add bar; waiting conditions are the remaining inline
composer on that screen.

When done:

- **Mobile:** the project screen's single plus FAB offers two modes — **Task |
  Waiting** — in its keyboard-docked quick-add bar. Selecting Waiting and
  submitting creates a free-text waiting condition on the project. The
  always-visible inline "Waiting on…" input is gone; the Waiting-on section shows
  only the open conditions (Resolve / delete).
- **Web:** the Waiting-on add is a compact "+" control that opens the condition
  builder in a popover (not an inline form that shifts the section). The builder
  keeps all three kinds (free-text, task-done, project-status).

## Background (for a fresh agent)

- The **waiting condition** is the todo app's fourth entity; it attaches to a
  **Project** and any unresolved one makes the project display `waiting`. Source
  of truth: `docs/entities/waiting-condition.md`. Kinds: `free-text` (resolved by
  hand/AI), `task-done` and `project-status` (code-satisfied). Mobile creates
  only `free-text` today; the structured kinds are web-only. That asymmetry is
  pre-existing and **stays** — this change moves the *affordance*, not the kind
  coverage.
- The project detail screen is a **per-surface** implementation, not shared UI:
  - Web: `apps/agent-web/src/pages/ProjectDetailPage.tsx` (route `/projects/:id`).
    Inline forms throughout; uses the `Popover` primitive already (for the icon
    picker). The Waiting-on add is the `ProjectWaits` component: a full-width "+
    Waiting condition" button that toggles an inline builder (kind `<select>` +
    per-kind fields + Add/Cancel), pushing the section layout.
  - Mobile: `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` (pushed
    screen). Plain RN view tree. The task composer is already the shared plus FAB
    (`QuickAdd`, `mode="task" modes={['task']}`). The Waiting-on add is the
    `ProjectWaits` component: an always-visible inline `Input` (free-text only).
- The **quick-add** is built per surface around a shared, pure add-mode registry
  `packages/agent-core/src/quick-add/modes.ts`: `AddMode = "capture" | "task" |
  "project"`, `ALL_ADD_MODES` (the global offered set), `ADD_MODE_LABEL`,
  `ADD_MODE_PLACEHOLDER`, `addModeA11yLabel`. The registry is "the single source
  of truth for what the quick-add box can create"; a single-purpose screen passes
  a narrowed `modes` list. The mobile widgets are `components/quick-add.tsx`
  (motion/FAB↔bar transition) and `components/quick-add-bar.tsx` (the pills +
  input); both render whatever `modes` they are handed. Web's quick-add is the
  mode-pill box inside `HomePage.tsx` (always-visible, reads `ALL_ADD_MODES`).
- The **waits data layer** is `createWaitsApi` (`@zero/agent-core`), surfaced as
  `getWaitsApi()` (web) / `useWaitsApi()` (mobile); `waitsApi.add(projectId,
  kind, params)` is the create verb, offline-replaying on a client-minted id.

## What to change and why

### 1. Shared: a project-scoped `"waiting"` add mode

`packages/agent-core/src/quick-add/modes.ts`:

- Add `"waiting"` to the `AddMode` union.
- **Do not** add it to `ALL_ADD_MODES`. Home and the Projects list have no
  project context and must never offer it; it is passed explicitly only on the
  project screen (`modes={['task', 'waiting']}`). This is exactly the "narrowed
  list per screen" case the registry already documents.
- `ADD_MODE_LABEL`: `waiting: "Waiting"` (the pill word).
- `ADD_MODE_PLACEHOLDER`: `waiting: "Waiting on…"`.
- The pill accessibility label: `addModeA11yLabel` today derives "Add a
  {label}", which yields the ungrammatical "Add a waiting". Give `waiting` an
  explicit label ("Add a waiting condition") — either by turning
  `addModeA11yLabel` into a per-mode map, or special-casing `waiting`. Prefer the
  map so the rule is uniform; the three existing labels are unchanged strings.

Why the registry and not a one-off mobile state: the mobile quick-add bar renders
from `modes`, and keeping the label/placeholder/a11y for every creatable thing in
one table is the established design — a second copy on the project screen would
be the exact drift the registry was extracted to prevent.

### 2. Mobile: fold Waiting into the project screen's plus FAB

`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`:

- Add `mode` state (`AddMode`, default `"task"`) to the screen, pass
  `mode={mode} modes={['task', 'waiting']} onModeChange={setMode}` to the
  existing `<QuickAdd>`. Drop the hardcoded `mode="task"` / `fabLabel="Add a
  task"`; let the placeholder come from the registry per mode.
- Branch `onAdd` on the selected mode: `task` → `tasksApi.add(...)` (unchanged);
  `waiting` → `waitsApi.add(project.id, 'free-text', { text: trimmed })`. Reset
  `mode` to `"task"` on close so the next open starts on the common case.
- `ProjectWaits` becomes **list-only**: remove its `text` state, `onAdd`, and the
  inline `Input` block. It keeps rendering the open conditions with Resolve (for
  free-text) / "auto" (structured) / delete.

This is structurally identical to the already-shipped task FAB; no data, API, or
collection change.

### 3. Web: "+" popover instead of the inline builder

`apps/agent-web/src/pages/ProjectDetailPage.tsx`, `ProjectWaits`:

- Replace the `adding`-toggled inline builder with a compact "+" control (e.g. a
  "+ Add" button or a "+" icon in the section header) that opens the **same
  builder inside a `Popover`** (the primitive is already imported in this file).
  The builder markup (kind `<select>`, free-text input, task picker, project +
  target-status pickers, "Add condition") moves into the popover content; on a
  successful add the popover closes and fields reset.
- Keep all three kinds. The popover removes the layout-shifting inline form,
  which is the "inline form" the request targets.

## Out of scope

- Bringing structured kinds (task-done, project-status) to mobile. Already a
  listed future item in `docs/todo-app.md`; mobile stays free-text.
- Web gaining a FAB. Web's project screen keeps its inline idiom; the "+" opens a
  popover, matching web's existing icon-picker pattern. "Shared only the view
  helpers, each surface in its own idiom" is the standing rule.
- Any change to the waits data layer, REST contracts, store, or the derivation
  (`projectDisplayStatus` / `waitingSince`).
- The Home quick-add and the Projects-list quick-add: `ALL_ADD_MODES` is
  unchanged, so neither offers Waiting.

## Tests to add or update

- **Mobile** `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx`:
  rewrite `'adds a free-text waiting condition'`. It currently finds the inline
  input by placeholder `"Waiting on… (e.g. the letter comes back)"`. New flow:
  open the FAB, select the **Waiting** pill (a11y "Add a waiting condition"),
  type into the bar, submit; assert `mockAddWaitingCondition` called with the
  text. Follow the existing task-add FAB test in the same file for the
  open-bar/pill/submit mechanics.
- **Web** `apps/agent-web/src/pages/ProjectsPage.test.tsx`: rewrite `'adds a
  free-text waiting condition from the detail screen'`. It currently clicks the
  `"+ Waiting condition"` button, then the `"Waiting condition"` textbox, then
  `"Add condition"`. New flow: click the new "+" control to open the popover,
  then the same textbox + "Add condition" inside it.
- **Shared** (optional, cheap): a unit assertion that `ALL_ADD_MODES` excludes
  `"waiting"` while `ADD_MODE_LABEL`/`ADD_MODE_PLACEHOLDER` cover it, guarding the
  "project-scoped, never global" invariant.

## Docs to add or update

- `docs/entities/waiting-condition.md` — the Interactions → UI line ("plus an add
  control") should name the new affordance: mobile via the project FAB's Waiting
  mode, web via a "+" popover.
- `docs/todo-app.md` — add a "Shipped" bullet and point at this plan.
- Changelogs (user-facing, same change):
  - `apps/agent-mobile/CHANGELOG.md` — mobile: "Add what a project is waiting on
    from the + button (a Waiting mode beside Task), not an always-open field."
  - `apps/agent-web/CHANGELOG.md` — web: "Add a waiting condition from a +
    control that opens a small composer, instead of an inline form."

## Skills to use

- `tdd` — rewrite the two screen tests first (red), then move the affordance
  (green); the behavior (a condition gets created) is unchanged, only the path.
- `git-commit` — when committing; one change carries code + tests + docs +
  changelog.
- Device rule: every mobile change is verified on the Pixel 7 before done
  (`AGENTS.md`). No new native/`@expo/ui` component is introduced (the FAB and
  quick-add bar already ship), so a pure-JS hot-reload on the existing dev client
  suffices — no fresh EAS build. Verify with Maestro: open a project, tap the
  FAB, pick Waiting, add a condition, see it in Waiting-on and the project derive
  to `waiting`.

## Acceptance criteria

- Mobile: the project FAB's bar shows Task and Waiting pills; Waiting + submit
  creates a free-text condition; no inline "Waiting on…" input remains; open
  conditions still Resolve/delete. Verified on the Pixel 7.
- Web: a "+" control opens the condition builder in a popover with all three
  kinds; adding closes it and the condition appears; no inline builder pushes the
  section.
- `ALL_ADD_MODES` still excludes `"waiting"`; Home and Projects-list quick-adds
  are unchanged.
- Both screen tests pass against the new affordance; lint + typecheck clean on
  `@zero/agent-core`, `@zero/agent-mobile`, `@zero/agent-web`.
- Changelog entries and the two docs updated in the same change.
