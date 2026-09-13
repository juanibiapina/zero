# Clarify task-derived waiting on the mobile project screen

## Bottom line

Rework the mobile project detail screen so a future task reads as a scheduled
task, not as an unexplained waiting condition:

1. Expand the header status from **“Waiting”** to **“Waiting · until Tomorrow”**
   when the shared derivation says the project is waiting for a task date.
2. Show **“Scheduled · Tomorrow”** as secondary text on the task that carries
   that date.
3. Reserve the **Waiting on** section for real `WaitingCondition` rows; remove
   the synthetic `until Tomorrow` / `auto` row derived from a task.
4. Render project tasks with the existing shared `ListRow`, which raises the
   minimum one-line row from about 38 dp to 46 dp, adds inset dividers, and makes
   the full row the edit target.

This is a mobile presentation change in
`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`. It changes no entity,
write, derivation rule, API, or stored data.

## Context

A project has two distinct ways to display as waiting:

- A real `WaitingCondition` row records an external reason such as “the letter
  comes back.” These rows belong under **Waiting on** and can be resolved or
  deleted.
- A future-dated open task makes its project wait until the earliest such date.
  `waitingUntil` derives this state from `Task.showUpDate`; no
  `waiting_conditions` row exists.

The current mobile screen presents both through **Waiting on**. A derived task
wait appears as `until Tomorrow` with an `auto` tag, detached from the task that
caused it. The task row omits its schedule because scheduling moved into the
shared task editor. In the supplied screen, nothing connects `until Tomorrow`
to “download all documents from Workday.”

The task section also hand-builds rows with `py-2`, no divider, and a pressable
text region. Other mobile lists use `src/components/ui/list-row.tsx`, whose
`py-row-y` token gives a 22 dp circle 12 dp above and below, for a 46 dp minimum
row and a full-row press target.

Existing deep modules already own the required rules:

- `waitingBadge` chooses the correct waiting context and precedence: a real
  condition first, otherwise the earliest future task date.
- `scheduleLabel` formats a task date as Today, Tomorrow, or a localized date.
- `ListRow` owns row spacing, press feedback, and the inset divider.

Reuse these interfaces. Do not add a new formatting module or a new seam for one
caller.

## What to change and why

### 1. Put the waiting context in the project status

In `ProjectDetail`, read `waitingBadge(project, tasks, conds, list, today)` and
build the header label from the derived status plus its optional label:

- date wait: `Waiting · until Tomorrow`
- condition wait: `Waiting · for 5 days` or `Waiting · just now`
- every other status: the existing `Active`, `Next`, `Backlog`, or `Done`

Pass the ready-to-render label to `ProjectHeader` and expose it as the project
status accessibility label. The middle dot keeps all `waitingBadge` outputs
grammatical and lets the pill retain its compact status-first hierarchy.

This reuses the same derivation that labels and orders the Projects list, so the
list and detail cannot disagree about which waiting reason wins.

### 2. Put each task's schedule on that task

Give `ProjectTasks` the screen's `today` value. For every task with a non-null
`showUpDate`, render a muted caption beneath the title:

- `Scheduled · Today`
- `Scheduled · Tomorrow`
- `Scheduled · Fri, 18 Sep` (localized by `scheduleLabel`)

Leave undated tasks as one-line rows. Include the schedule in the row's
accessibility label, for example `Edit “download all documents from Workday”,
scheduled Tomorrow`.

The caption is informational. Tapping the row still opens the shared
`useTaskDetail` editor, where the user changes the date. Do not restore the old
inline date button; that would recreate a second scheduling interaction found
only on this screen.

### 3. Keep only actual conditions under “Waiting on”

Remove the `waitingUntil` synthetic row from `ProjectWaits`. The section renders
only persisted, open conditions:

- free-text conditions keep Resolve and Delete;
- structured conditions keep `auto` and Delete;
- a date-only wait no longer creates or displays a condition-like row.

When a project waits only for a future task, **Waiting on** remains hidden. The
header states when the project resumes, and the matching task row shows the same
date at its source.

### 4. Give the task list the established row rhythm

Replace each ad hoc `flex-row ... py-2` task wrapper with `ListRow`:

- pass `CheckCircle` through `leading`;
- make `ListRow.onPress` call the existing `onOpen` callback;
- render the title and optional schedule caption in its body;
- keep completion routed through `useTaskDetail.complete`, including Undo;
- keep the section heading separately padded with `px-screen-x`, while rows run
  full width so `ListRow` owns horizontal padding and its inset divider.

Update `ListRow`'s comment to name project detail as a caller. Do not increase
`--spacing-row-y` globally; Home, Upcoming, and the Projects list already use the
intended token.

## Out of scope

- The web project page. It already shows an inline date chip on each task; this
  plan targets the supplied mobile screen. A later parity pass can remove its
  synthetic `auto` row if desired.
- Changes to `waitingUntil`, `waitingBadge`, `projectDisplayStatus`, or the
  status precedence.
- Task ordering, drag-to-reorder, swipe actions, completed-task history, or new
  scheduling controls.
- Changes to quick-add, the task editor, waiting-condition creation, storage,
  REST routes, or migrations.
- A global density change across Home, Upcoming, or the Projects list.

## Tests

Update
`apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` through
the screen interface:

1. Replace the current derived-wait assertion with a task dated via
   `tomorrow(localToday())`; assert the header says
   `Waiting · until Tomorrow`, that task's row contains
   `Scheduled · Tomorrow`, and **Waiting on** plus the synthetic `auto` label are
   absent.
2. Add a mixed-state case with a future task and a real free-text condition;
   assert the task keeps its schedule caption, **Waiting on** contains only the
   real condition, and the header uses the condition-precedence label rather
   than claiming the date is the active reason.
3. Keep the existing empty-section, task-open, edit, complete-with-Undo, and
   waiting-add tests. They guard that the `ListRow` composition changes only
   presentation and expands the full-row edit target.
4. Avoid snapshots or assertions on raw class strings. The test surface is the
   visible/accessibility output; row rhythm is verified on the device.

During implementation, stop Metro and other memory-heavy mobile jobs, then run
package checks serially:

```bash
pnpm --filter @zero/agent-mobile test -- --runInBand
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-export
```

The repository-wide `gob run bin/ci` remains subject to the documented local
`workerd` limitation; GitHub Actions covers the whole-repo checks.

## Device verification

A mobile change is not done until it passes on the USB-attached Pixel 7. Use the
development dev client, headless Metro, `adb reverse tcp:8081 tcp:8081`, and
Maestro. The dev client targets production data, so create and later delete only
throwaway entities.

1. Create a throwaway project with a distinctive name.
2. Add one undated task and one task scheduled for Tomorrow.
3. Reopen the project and verify:
   - the status pill reads `Waiting · until Tomorrow`;
   - the scheduled task reads `Scheduled · Tomorrow` directly beneath its name;
   - no **Waiting on** section appears;
   - rows have clear vertical separation and dividers, remain easy to tap, and
     long task names wrap without colliding with another control.
4. Tap each row to confirm the shared editor still opens; complete one and Undo
   it.
5. Add a free-text waiting condition and verify **Waiting on** now appears with
   that condition only; the task schedule remains attached to its task.
6. Capture a screenshot and `maestro hierarchy`, then delete the throwaway
   project so its tasks and condition cascade away.

## Documentation

Ship the documentation with the code:

- Add a user-facing bullet to `apps/agent-mobile/CHANGELOG.md` after loading the
  `changelog` skill. State that scheduled project tasks now show their date at
  the task, task-derived waiting appears in the status instead of as an
  unexplained automatic condition, and task rows are roomier.
- Update `docs/entities/project.md` so the mobile project-screen task row owns
  visible schedule metadata and uses the shared list rhythm; remove its stale
  claim that mobile has an inline date chip.
- Update `docs/entities/waiting-condition.md` to state that a derived date wait
  is not displayed as a condition on mobile: the status carries the date and the
  source task carries its schedule. Keep the web behavior explicit because web
  remains out of scope.
- Add the shipped, Pixel-verified result to the top of the Project tracking
  section in `docs/todo-app.md` when implementation and device verification are
  complete.

## Skills to use

- `impeccable` — preserve the incumbent mobile visual system while refining
  hierarchy, spacing, copy, and accessibility.
- `expo-overview` and `expo-native-ui` — apply Expo SDK 57 and native mobile
  layout rules during implementation.
- `expo-ui` — confirm no native list is appropriate; project tasks are an
  unknown-length list, so retain React Native rows rather than `@expo/ui` List.
- `deep-modules` — reuse `waitingBadge`, `scheduleLabel`, and `ListRow`; do not
  introduce a one-caller seam.
- `tdd` — change the derived-wait screen test first, then implement the new
  presentation.
- `changelog` — write the required mobile changelog entry with the code.
- `reproducible-locally` — structure the package checks and Pixel 7 walkthrough
  as observable proof.
- `git-commit` — commit UI, tests, entity docs, tracking, and changelog together.

## Acceptance criteria

- A project waiting only for a future task shows
  `Waiting · until <day>` in its header.
- Every dated project task shows `Scheduled · <day>` beneath its title; an
  undated task remains one line.
- The earliest date in the status is visibly present on at least one task row,
  so the source of the wait is identifiable without opening an editor.
- A task-derived date wait does not appear under **Waiting on** and does not show
  an `auto` tag.
- **Waiting on** still renders, resolves, and deletes real conditions exactly as
  before.
- Project task rows use `ListRow` spacing and dividers, meet a 44 dp minimum tap
  height, allow long names to wrap, and open the shared editor from the full row.
- No derivation, persistence, API, quick-add, task-editor, or web behavior
  changes.
- Mobile tests, lint, typecheck, Android export, and the Pixel 7 walkthrough
  pass; the throwaway data is deleted; the changelog and entity documentation
  ship in the same commit.

## Risks and mitigations

- **The header could name the wrong reason when a task date and a real condition
  coexist.** Use `waitingBadge`, not `waitingUntil`, because it already owns the
  condition-before-date precedence. Cover the mixed state in the screen test.
- **A second text line can trade cramped rows for noisy rows.** Show it only for
  dated tasks, use the existing muted caption style, and verify minimum,
  typical, long-title, and mixed dated/undated rows on the Pixel 7.
- **A nested completion control inside a pressable row can route the wrong
  action.** Reuse the exact `ListRow` + `CheckCircle` composition already proven
  in Upcoming, then verify completion, row-open, and Undo separately on-device.
- **The visual fix can pass Jest while still feeling wrong on native Android.**
  Jest checks semantics only; the mandatory screenshot and hierarchy pass own
  spacing, wrapping, and tap-target verification.
