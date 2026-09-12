# Project-screen task rows open the shared editor, and one quick-add composer serves every screen

## Bottom line

Make the project screen (`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`)
reuse the two add/edit surfaces the rest of the app already shares, so it stops
diverging:

1. **Tap a task on a project's screen → open the same task detail editor** Home
   and Upcoming open (`useTaskDetail`). Today the project-screen task row is not
   tappable at all — only its date chip and complete circle do anything.
2. **Add a task on a project's screen → the same quick-add composer** Home uses
   (date chip + project context + discard-confirm + keyboard-race handling),
   instead of the project screen's stripped-down "add undated task" path.

The second change requires a **new deep module** — a `useQuickAdd` hook that owns
the whole quick-add surface (state, per-mode writes, sheets, Back handling)
behind a small interface — because the composer logic currently lives inline in
Home only, and the project screen reimplemented a thin version that already drifted.
Extracting it once, used by two callers, stops a third divergence.

## Context a fresh agent needs

This is the mobile todo app (`apps/agent-mobile`, an Expo/React Native app). It
is **not** the Zero agent. Its user-facing changelog is
`apps/agent-mobile/CHANGELOG.md`. Every mobile change must be verified on the
real Pixel 7 before it is done (see `apps/agent-mobile/README.md`), using
throwaway entities — never mutate the user's real production data.

### The three task-bearing screens today

- **Home** (`(signed-in)/index.tsx`): one reorderable list of tasks. Tapping a
  row opens the task detail editor via the shared `useTaskDetail` hook. Adding
  uses a rich inline **quick-add composer**: text + a mode pill (task/project) +
  a create-time **date chip** (`ScheduleSheet`) + a **project chip**
  (`ProjectPickerSheet`), plus discard-confirm, a keyboard-hide close race guard,
  and toasts ("Project created", "Filed to project"). All of this state and the
  `onAdd` write logic sit inline in the `Home` component (~150 lines).
- **Upcoming** (`(signed-in)/upcoming.tsx`): future-dated tasks grouped by day.
  Tapping a row opens the **same** `useTaskDetail` editor. It has no quick-add.
- **Project detail** (`(signed-in)/projects/[id].tsx`): a project's own screen.
  Its `ProjectTasks` section renders task rows where **the text is not
  pressable** — only the per-row date chip (opens `ScheduleSheet`) and the
  complete circle work. Adding uses a **bare `QuickAdd`** with modes
  `['task','waiting']`; its `onAdd` calls `tasksApi.add(trimmed, null, project.id)`
  (always undated) or `waitsApi.add(...)`. No date chip, no project chip (the
  project is fixed), no discard-confirm, no keyboard-race guard.

### The shared editor already exists (`useTaskDetail`)

`apps/agent-mobile/src/components/task-detail.tsx` exports `useTaskDetail`, a deep
module already used by Home and Upcoming. Interface:

- `open(task)` — open the editor for a task.
- `complete(task)` — complete with the shared single Undo snackbar.
- `sheets: ReactNode` — the detail sheet + `ScheduleSheet` + `ProjectPickerSheet`,
  rendered at the screen root.
- `handleBack(): boolean` — consume one Android Back press (returned, not
  self-registered, so each screen keeps its own Back priority).
- `active: boolean`.

It resolves the selected task as `list.find(id)` from the **screen's visible
list** passed in, so a reschedule that moves the task out of that list closes the
sheet. Change #1 is simply: adopt this hook on the project screen too.

### The reusable pieces the composer is built from

`ScheduleSheet` and `ProjectPickerSheet` are already exported from
`task-detail.tsx`. `QuickAdd` (`components/quick-add.tsx`) is the shared bar/FAB
with optional `dateChipLabel`/`onDateChipPress` and `projectChipLabel`/
`onProjectChipPress` props. `ConfirmDialog` (`components/ui/confirm-dialog.tsx`)
is the discard dialog. `AddMode` is `"task" | "project" | "waiting"`
(`packages/agent-core/src/quick-add/modes.ts`); mode labels/placeholders already
live in that shared `quick-add` module. All the raw materials exist; only the
**orchestration** is duplicated/diverged.

## What to change and why

### Change 1 — project task rows open the shared editor

In `projects/[id].tsx`:

- Call `useTaskDetail` in the `ProjectDetail` component (where the open-tasks
  live query already exists). Pass it the project's open tasks as `list`
  (filter `openTasks` by `projectId`), `projects: list`, and `onError: setError`.
- Render `detail.sheets` at the screen root (alongside the existing `QuickAdd`).
- Pass `detail.open` and `detail.complete` down into `ProjectTasks`; make the
  task **text pressable** (`onPress={() => onOpen(t)}`) exactly like the Upcoming
  row, and route the complete circle through `detail.complete` so the Undo
  snackbar is the shared one.
- Wire Back: the screen's `hardwareBackPress` handler must call
  `detail.handleBack()` first (so an open sheet/scheduler closes before the
  quick-add or the screen pops).

**Decision — remove the per-row inline date chip.** "Like other places" means the
row is circle + (project) text, and scheduling happens inside the editor (which
already has a schedule row). Keeping a second inline scheduler on only this
screen is the divergence we are removing. The grooming flow (date a task to
commit it to Home) still works: tap the task → tap the schedule row → pick a day.
This reverts the project-screen half of the 2026-09-12 "date chip on each task"
UI, but not the underlying model (the show-up date is still the sole commitment
gate). `ProjectTasks`' own `scheduling` state and its inline `ScheduleSheet` are
deleted (the editor owns it now). **Flagged for review:** if fast one-tap
grooming on the project screen is worth keeping the row inconsistent, the
alternative is to keep the chip and only add tap-to-edit — say so and I will keep
it.

### Change 2 — extract `useQuickAdd`, the quick-add composer deep module

Create `apps/agent-mobile/src/components/quick-add-composer.tsx` exporting a
`useQuickAdd` hook, structured as a sibling of `useTaskDetail`. It owns **all**
quick-add state and behavior behind a small interface, so Home and the project
screen render the same composer and cannot drift again.

**Interface (small):**

```ts
type QuickAddController = {
  bar: ReactNode;            // <QuickAdd> + <ScheduleSheet> + <ProjectPickerSheet> + <ConfirmDialog>
  handleBack: () => boolean; // consume one Android Back press
  active: boolean;           // bar open or any composer sheet/dialog open
};

function useQuickAdd(config: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  projects: Project[];             // for the project chip + "filed" toast copy
  modes: AddMode[];                // Home: ['task','project']; project: ['task','waiting']
  projectId?: string | null;       // this screen's home project (project screen). When set:
                                   //   - PRESETS the project chip to it (still changeable)
                                   //   - a 'waiting' add records a condition on it
                                   //   - filing a dateless task to THIS project fires no toast
                                   //     (it lands in the project's Tasks); filing to another does
  bottomOffset: number;
  getToken: TokenGetter;           // for project-create icon suggestions (Home)
  onError: (message: string | null) => void;
  fabLabel?: string;
}): QuickAddController;
```

**Depth:** a large amount of behavior sits behind that interface — the open/close
state machine, per-mode writes (`task` → `tasksApi.add(text, addDate,
projectId)`; `project` → `projectsApi.add` + icon-suggestion warm + "Project
created" toast with deep-link; `waiting` → `waitsApi.add(projectId, 'free-text',
{ text })`), the create-time date and project composer sheets, the
keyboard-hide close-race guard (`suppressKbCloseUntil`), the discard-confirm
flow, and Back handling. Callers learn three fields.

**The two adapters that make the seam real:**

- **Home:** `useQuickAdd({ modes: ['task','project'], projectId: undefined,
  fabLabel: 'Task', ... })` → shows the project chip, offers project mode.
- **Project screen:** `useQuickAdd({ modes: ['task','waiting'], projectId:
  project.id, fabLabel: 'Add', ... })` → offers waiting mode, and the new **date
  and project chips are now available on the project screen** — the concrete
  "same add screen" the request asks for. The project chip is **preset** to this
  project but changeable (revised from the original "hide it" plan, per the
  request: show it, preset, changeable). The date chip defaults to "No date",
  preserving today's undated-by-default grooming while letting the user optionally
  date at create time.

Both then render `{add.bar}` and delegate Back to `add.handleBack()`.

**Config-gated modes, not a generic bag.** The mode set is closed (`AddMode`),
and each mode's write is a fixed branch, so this is one coherent deep module (the
quick-add surface), not a `Repository<T>`-style uniform CRUD bag. The
`projectId` config is the single knob that flips fixed-context vs free-context
behavior. This matches the app's per-entity, behavior-forcing philosophy
(`docs/todo-app.md`): a mode is wired by adding its branch, not by a no-op in a
shared abstraction.

**Home is refactored to consume the hook** — the ~150 lines of inline quick-add
state, effects, and `onAdd` move into `useQuickAdd`. Home keeps only
`useTaskDetail` and the list. This is replace-don't-layer: the inline code is
deleted, not wrapped.

## Out of scope

- The **projects list** screen (`projects/index.tsx`) quick-add, which adds
  projects, not tasks. It could later adopt `useQuickAdd` too, but this change
  targets only the two task surfaces named in the request. (Noting it as the
  natural third caller if a future divergence appears.)
- The web app (`apps/agent-web`) — mobile only.
- Structured waiting kinds (task-done, project-status) — still web-only; the
  project screen's waiting add stays free-text, unchanged.
- Any change to the task/project/waiting data layer in `packages/agent-core`
  (the APIs already expose everything needed).
- Server-side changes.

## Test strategy

Tests run in Jest via the Turbo pipeline (`jest --runInBand` on the starved box).
Replace, don't layer: keep asserting through the screen surfaces.

- **Project screen — tap opens the editor** (`project-detail.test.tsx`): render a
  project with an open task, press the task text, assert the detail editor input
  (`testID="task-edit-input"`) appears; edit + dismiss and assert `tasksApi.edit`
  is called (the shared editor's commit-on-dismiss).
- **Project screen — add shows the date chip and files to this project**: open
  the quick-add, assert the **date chip** is present (it was absent before) and
  the **project chip is not** (fixed context), type text, submit, assert
  `tasksApi.add` is called with `projectId = <this project>` and the chosen date
  (null by default; a set date when the schedule sheet picks one).
- **Project screen — waiting mode still records a free-text condition** (guard
  against the extraction breaking the existing path): submit in waiting mode,
  assert `waitsApi.add(projectId, 'free-text', { text })`.
- **Home — existing quick-add tests still pass unchanged** (`index.test.tsx`):
  they exercise the composer through the screen, so they validate the extraction
  without edits. If any reach into inline Home state, port them to the same
  screen-level assertions.
- **On-device (Pixel 7), mandatory before done**: create a throwaway project,
  add a task from its screen (verify the date chip works and the task attaches),
  tap the task to edit it, reschedule and complete it (verify the shared Undo),
  then delete the throwaway project. Never touch the user's real entities.

## Documentation

- **Changelog** (`apps/agent-mobile/CHANGELOG.md`, same change): one user-facing
  entry, e.g. "On a project's screen you can now tap a task to open the full
  editor (rename, schedule, move, complete), the same as Home and Upcoming — and
  adding a task there now uses the same composer, including an optional date."
  Note the removed inline date chip in the same entry so the 2026-09-12 behavior
  change is recorded.
- **`docs/todo-app.md`**: if it tracks the Rule-of-Three client extraction, add a
  line that the quick-add composer is now a shared deep module
  (`useQuickAdd`), alongside `useTaskDetail`.
- Code comments on `useQuickAdd`: name the mechanism (mirror the `useTaskDetail`
  header), state why `projectId` gates the project chip and the toast, and why
  Back is returned rather than self-registered.

## Skills to use

- `deep-modules` — designing `useQuickAdd`'s interface and seam; applying
  replace-don't-layer when deleting Home's inline composer.
- `vocabulary` — consistent terms (module, interface, seam, adapter, depth) in
  code comments and the commit message.
- `tdd` — write the project-screen tap-to-edit and add-with-date tests first,
  then wire the screens.
- `git-commit` — when committing (one commit: extraction + both screens + tests +
  changelog).
- `reproducible-locally` — the on-device Pixel 7 verification is the proof step;
  do not call it done on unit tests alone.

## Acceptance criteria

- On a project's screen, tapping a task's text opens the same detail editor as
  Home/Upcoming (rename on dismiss, schedule, move-to-project, complete-with-Undo).
- On a project's screen, the complete circle raises the shared single Undo
  snackbar (not a divergent one).
- On a project's screen, adding a task uses the shared composer: a date chip is
  present, the project chip is absent, and the created task attaches to the
  current project with the chosen date (null by default).
- Waiting-mode add on the project screen still records a free-text condition.
- Home's quick-add behaves exactly as before (project mode, date chip, project
  chip, "Project created"/"Filed to project" toasts, discard-confirm, keyboard
  race), now served by `useQuickAdd`.
- The inline quick-add state/`onAdd` is gone from Home; the per-row date chip and
  its `ScheduleSheet` are gone from `ProjectTasks` (both live in the shared
  modules).
- Unit tests above pass; the Pixel 7 walkthrough passes; a changelog entry ships
  in the same change.

## Risks and mitigations

- **Back-priority ordering.** Home now chains `detail.handleBack()` →
  `add.handleBack()`; the project screen adds the same chain where it had only a
  quick-add close. Mitigation: keep the existing order (editor sheets close
  before the composer, composer closes before the screen pops) and cover it with
  the on-device Back walkthrough.
- **Keyboard-hide close race regresses in extraction.** The
  `suppressKbCloseUntil` guard is subtle (commit `a9acf9050` fixed it once).
  Mitigation: move it verbatim into the hook; verify on-device that opening the
  date/project sheet does not close the bar.
- **Removing the inline date chip is a visible behavior change** to the
  2026-09-12 grooming flow. Mitigation: it is flagged above for a go/no-go, the
  grooming path still exists via the editor, and the changelog records it.
- **`useTaskDetail` list scoping on the project screen.** Pass the
  project-filtered open tasks as `list` so a move-to-another-project closes the
  sheet (task leaves the list) and a reschedule keeps it open (project screen
  shows all open tasks regardless of date) — the intended, consistent behavior.
```

