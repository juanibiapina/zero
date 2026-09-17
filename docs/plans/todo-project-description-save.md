# Save project descriptions before every workspace action

## Bottom line

The mobile Project workspace keeps its description in `ProjectDescription` and
persists it only from `TextInput.onBlur`. The task list uses
`keyboardShouldPersistTaps="handled"`, so a handled tap such as **Add** can run
without blurring the field. Back navigation can then unmount the only copy of
the draft before any edit transaction exists.

Move description-draft ownership into the Project workspace and give it one
synchronous `flush` operation. A screen-level action seam must call `flush`
before any touch action, Android Back handling, or route focus loss. `flush`
queues the existing optimistic, offline-durable `ProjectsApi.edit` transaction;
it must not wait for the network before continuing the user's action. Keep all
detailed save-trigger cases in Jest. Add one broad hermetic Pixel flow that
creates a Project, enters a description, leaves the Project, reopens it, and
proves the stored description through the local Worker's HTTP interface.

## Goal

A description typed on the mobile Project workspace is retained when the user
does anything else, including opening **Add** and pressing either the visible
Back control or Android Back. The behavior remains local-first and works
offline. Blank descriptions still persist as `null`, unchanged descriptions
produce no write, and one action produces at most one edit transaction even if
blur and navigation events overlap.

## Current state and root cause

- `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` renders
  `ProjectDescription`, which owns `useState(project.description ?? '')` and
  calls `onEdit` only from `onBlur`.
- The same screen renders `ReorderableTaskList` with
  `keyboardShouldPersistTaps="handled"`. Taps handled by the main Add control,
  section Add controls, status/icon/settings controls, task rows, and
  relationship rows are not a reliable description-save signal.
- The visible Back control calls `router.back()` directly. The Android Back
  handler delegates open drawers and otherwise returns `false`, allowing the
  navigator to pop without committing the description.
- `commitEdit` already uses the correct persistence interface:
  `ProjectsApi.edit` updates the local collection immediately, survives screen
  unmount through the app-lifetime collection, and reports persistence failure
  through `tx.isPersisted.promise`.
- `useTaskDetail` in `apps/agent-mobile/src/components/task-detail.tsx` is the
  local precedent: it owns a draft and calls one `commitDraft` operation before
  opening another control, completing, navigating, or closing. Project
  descriptions need the same policy at the Project-workspace seam.
- No Project store, HTTP route, schema, migration, or shared collection change
  is needed. `PATCH /api/projects/{id}` already accepts `description`, and
  `GET /api/projects` already returns it.

## Technical approach

### 1. Put the draft and `flush` behind one screen-local module

Refactor `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` so the
Project workspace, not the leaf input, owns the current description draft. Keep
the module internal to this screen unless a second real caller appears.

Its small interface must provide:

- the controlled input value and change handler;
- `flush()`, which normalizes all-whitespace text to `null`, compares it with the
  latest stored or already-queued value, and calls the existing `commitEdit`
  exactly once for a real change;
- synchronization by Project id so navigating between Project routes never
  carries one Project's draft into another;
- a latest-value ref for lifecycle callbacks, so Android Back and route cleanup
  cannot read a stale render;
- duplicate suppression when a touch, `onBlur`, Android Back, and route cleanup
  all describe the same edit.

Keep the user's uncommitted text in the input if persistence fails. The existing
write-error path remains responsible for the error, and a later `flush` can
retry after the optimistic collection rollback. Do not debounce, persist per
keystroke, await `isPersisted.promise`, or add another persistence adapter.

### 2. Make all workspace actions cross one save seam

At the Project workspace root, flush the latest draft before dispatching a
screen touch action. This concentrates the rule once instead of threading a
`saveDescription` prop through `ProjectHeader`, `ProjectWaits`,
`ReorderableTaskList`, `useProjectAdd`, and every future control.

Also call the same `flush` explicitly from non-touch exit paths:

- the visible **Back to projects** action before `router.back()`;
- the Android `hardwareBackPress` handler before it closes an overlay or lets
  the Projects stack pop;
- Expo Router focus-loss/unmount cleanup, using a stable latest-value ref, as a
  safety net for native back gestures, tab changes, and navigation initiated
  outside this screen;
- the description input's existing blur path, for keyboard dismissal and
  assistive-focus changes.

The root interaction hook must observe touches without claiming the responder,
changing gesture arbitration, dismissing the keyboard, or requiring a second
tap. Verify that task swipe, reorder, pull-to-refresh, sheets, and native menus
retain their existing behavior. Direct callbacks for Back remain even if the
same physical tap also reaches the screen-level hook; duplicate suppression
makes that harmless.

This is an in-process dependency. Do not introduce a port or a reusable generic
form abstraction: only one draft currently needs this behavior.

### 3. Keep detailed behavior in the Project screen Jest suite

Extend
`apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` through
the rendered screen interface. Add a helper that performs the same
screen-interaction sequence as a native action, then cover:

1. blur persists a changed description;
2. opening the main **Add** control queues the description before the drawer
   opens, then adding a Task does not lose it;
3. the visible Back control queues the description before `router.back()`;
4. unhandled Android Back queues the description and still returns control to
   the navigator;
5. representative identity, relationship, and task actions cross the same
   screen-level save seam, preferably as a table-driven case rather than one
   bespoke test per control;
6. route focus loss/unmount flushes a dirty draft that no child control handled;
7. overlapping touch/blur/back cleanup queues only one description edit;
8. an unchanged description queues no edit;
9. clearing a non-empty description sends `{ description: null }`.

Assert observable results: the exact `editProject` fields, the opened drawer or
navigation result, and call ordering where navigation could destroy the draft.
Do not test refs, hook state, or event-handler implementation directly.

### 4. Add one major-flow hermetic mobile test

Add one behavior-named flow under
`apps/agent-mobile/.maestro/hermetic/`, after the existing Task flow. It must:

1. launch the existing hermetic development-client session;
2. open Projects and create a deterministic Project;
3. enter a deterministic description on the new Project workspace;
4. press **Back to projects** while the edit is still current;
5. reopen the Project and assert that the description is visible.

Do not duplicate the Jest matrix in Maestro. The Pixel flow does not need
separate cases for Add, blur, status, icon, hardware Back, blank text, or
write deduplication. Its purpose is to prove the major Project-create/edit/
navigate composition on the real Pixel 7.

Extend `apps/agent-mobile/.maestro/run-metro-e2e.sh` without widening its public
interface:

- require an empty Project list during preflight;
- after Maestro, query both `/api/tasks` and `/api/projects` for
  `e2e-test-user`;
- retain the existing exact Task assertion and additionally require exactly the
  deterministic Project with the deterministic description;
- save both HTTP responses in the artifact directory;
- derive the success flow count from the hermetic YAML files instead of keeping
  `PASS: 1 flow` hard-coded.

The local Worker, fake identity, isolated device stores, production checksum
checks, launcher checks, and dev-client identity checks remain unchanged. The
manual emulator adapter already runs the whole hermetic folder and needs no new
behavior unless the added flow exposes an adapter defect.

### 5. Update current documentation with the shipped contract

- Load the `changelog` skill, then add this most-recent bullet to
  `apps/agent-mobile/CHANGELOG.md`:
  `- 2026-09-17: Project descriptions now save before you add work, open another control, or leave the Project, so Back no longer loses what you wrote.`
- Update `docs/entities/project.md`, the Project behavior source of truth, to
  state that a dirty description is queued before another workspace action or
  navigation and that blank text clears it to `null`.
- Update the top of Project tracking in `docs/todo-app.md` after implementation
  with the fix, Jest coverage, and Pixel result.
- Update the mobile README's hermetic E2E section: it will run two behavior
  flows, prove one Task plus one described Project through the Worker, and print
  a derived flow count.
- Keep `docs/plans/todo-mobile-metro-e2e.md` unchanged as historical rationale.
  `docs/e2e-tests.md` already describes the generic mobile UI + HTTP proof and
  needs no edit unless implementation makes that wording inaccurate.

## Out of scope

- The web Project page, which has a separate textarea and browser blur model.
- Project-title save behavior.
- A generic autosave framework, debounce policy, background sync redesign, or
  per-keystroke HTTP writes.
- Project schema, Worker route, Durable Object store, collection-interface, or
  database changes.
- A Maestro case for every save trigger; those cases belong in Jest.
- Visual redesign, keyboard behavior changes, gesture tuning, or a native
  dependency/build change.

## Verification

Stop normal Metro and any Gradle/EAS local build before checks on `mini`. Run:

```bash
pnpm --filter @zero/agent-mobile test -- --runInBand
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile exec expo export \
  --platform android \
  --output-dir /tmp/zero-agent-mobile-project-description-save
gob run bin/ci
pnpm --filter @zero/agent-mobile e2e:pixel
```

`gob run bin/ci` remains the repository check; record the documented unrelated
host-`workerd` limitation if it prevents whole-repository completion after the
touched mobile checks pass. The final behavioral proof must be
`e2e:pixel` on the attached real Pixel 7. This is a pure TypeScript/JavaScript
change, so use the installed development client and do not build or install an
APK.

A valid Pixel result proves all of these through one command:

- the current checkout loaded from hermetic Metro;
- the existing loose Task still persisted;
- the new Project and its description survived Back and reopening;
- the local Worker returned the exact Task and described Project;
- production stores, launcher state, and development-client identity stayed
  unchanged;
- all harness processes and reverse ports were removed.

## Skills to use

- `vocabulary` — keep module, interface, implementation, seam, and adapter terms
  consistent.
- `deep-modules` — concentrate draft normalization, deduplication, and lifecycle
  saves behind one screen-local `flush` interface.
- `documentation` — update each current fact once and leave historical plans
  historical.
- `expo-overview` — preserve the Expo SDK 57 and dev-client rules.
- `expo-router` — implement Back and focus-loss safety without bypassing the
  Projects stack.
- `testing` — assert screen-visible behavior and HTTP postconditions rather than
  internal hook state.
- `tdd` — add failing Jest cases for Add and Back before changing draft
  ownership.
- `changelog` — add the mobile user-facing fix in the required format.
- `reproducible-locally` — record the exact package and Pixel evidence.
- `git-commit` — commit implementation, tests, flow, harness, changelog, and
  current docs together when requested.

## Acceptance criteria

- Typing a Project description and immediately pressing Add queues the
  description before the drawer opens; adding a Task cannot discard it.
- Typing a description and immediately leaving through visible Back, Android
  Back, a native navigation path, or route focus loss queues the description
  before the draft can unmount.
- Any screen touch action after editing queues the same description through one
  screen-level seam; future controls inherit the policy without a new callback.
- Description writes remain optimistic and offline-durable and never block an
  action on network completion.
- Empty text persists as `null`; unchanged text produces no write; overlapping
  action/blur/lifecycle signals produce one edit transaction.
- Existing Project actions, task gestures, refresh, drawers, sheets, menus, and
  navigation remain operable with one tap.
- Detailed save-trigger coverage lives in Jest. Exactly one new Maestro flow
  covers Project creation, description entry, Back, reopening, and the Worker
  postcondition.
- Mobile Jest, lint, typecheck, Android export, the repository check to the
  extent supported on this host, and `e2e:pixel` pass.
- The mobile changelog, Project entity doc, Todo tracking, and mobile E2E README
  ship with the code; no server or web changelog changes are made.
