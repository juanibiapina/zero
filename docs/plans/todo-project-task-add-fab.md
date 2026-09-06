# Adding a task to a project on mobile: a plus FAB, not an inline field

Rework how a task is added on the mobile project screen
(`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`). Replace the
always-visible inline "Add a task to this project…" text field at the bottom of
the Tasks section with the same **plus FAB → keyboard-docked quick-add bar** the
Home and Projects-list screens already use. The bar is **task-only** — it has no
Capture/Task toggle and no capture picker — so a task added there lands directly
in the open project. This is a UI/interaction rework of one screen: no data, API,
store, collection, or derivation change.

## Why

- The project screen was the odd one out. Every other add surface on mobile (the
  Home inbox, the Projects list) is a floating `Fab` that expands into the shared
  `QuickAdd` bar; only the project screen still used a raw inline `Input` at the
  bottom of its Tasks section. The FAB gives the screen one consistent,
  discoverable add affordance that follows the keyboard.
- "Captures aren't selectable from that screen" falls out for free: `QuickAdd`
  shows the Capture/Task toggle **only when passed a `mode` prop**
  (`components/quick-add.tsx` / `quick-add-bar.tsx`). The Projects-list screen
  already omits `mode` for a single-purpose add; the project screen does the
  same, so the FAB adds a fresh task and nothing else — no capture mode, no way
  to pick an existing capture.

## What changed

`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`:

- The task-add state (`text`, `adding`, `inputRef`) and the `onAdd` handler moved
  up from `ProjectTasks` to the screen component, where the FAB overlay lives and
  `project.id` is in scope. `onAdd` keeps the existing behavior:
  `tasksApi.add(trimmed, localToday(), project.id, null, refiningCaptureId())` — a
  task **parked by default** (grooming is collect-then-take-on), linked to the
  refine capture when one is active. The bar stays open and cleared after submit
  for rapid entry.
- `ProjectTasks` is now display + complete/park only; its inline `Input` composer
  is gone.
- `QuickAdd` renders as a sibling of the `ScrollView`, mirroring
  `projects/index.tsx`: `fabLabel="Add a task"`,
  `placeholder="Add a task to this project…"`, no `mode`.
- A `bottomOffset` measurement (`rootRef` + `onLayout`, copied from the Home and
  Projects screens) docks the keyboard-sticky bar flush above the keyboard and
  the still-visible bottom tab bar (this is a pushed screen that keeps the tab
  bar).
- Android hardware Back closes the quick-add before it pops the screen.

## Non-goals

- The **waiting-condition** add stays an inline field in its section — this
  rework is tasks only.
- No change to complete / take-on / park, the header, description,
  Done/Delete-with-Undo, or pull-to-refresh.
- Web is unchanged; no new columns, no reschedule, no capture picker.

## Tests

`apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` — the
"adds a task to the project from its screen" test opens the FAB
(`getByLabelText('Add a task')`) before typing and submitting, then asserts the
row renders and the task's `projectId` is the open project. The other detail
tests are unchanged. Suite green (9/9). Lint clean.

On this box `tsc` reports a pre-existing error in `projects/index.tsx`
(`router.push(\`/projects/${id}\`)`) from stale Expo typed-routes; it is present
on clean `main` and regenerated in CI, unrelated to this change.

## On-device verification (done)

Verified on the attached Pixel 7 via the dev client + `adb reverse` + headless
Metro, driven with Maestro. Confirmed: the project screen shows the plus FAB and
no inline task field; tapping it opens the task-only bar
(placeholder "Add a task to this project…"); submitting adds the task to the
project, parked (☆) by default, and keeps the bar open above the tab bar; the
waiting-on field stays inline and the bottom tab bar stays; Android Back closes
the bar first, then a second Back pops to the list. The header "⋯" actions sheet
(Move to backlog / Mark done / Delete project) still opens as a native sheet.

Pure-JS change, so it hot-reloaded on the dev client without a new EAS build. Note
for this box: after a dependency reinstall, Metro must be started with `--clear`
or it fails to resolve the pnpm-symlinked `expo-router/entry` and the dev client
crashes with a 404 before any JS loads.

## Documentation

- `docs/entities/project.md` — "Interactions → UI" and "Other entities" describe
  the task-only FAB and that captures aren't selectable there.
- `apps/agent-mobile/CHANGELOG.md` — user-facing bullet.
