# Redesign delete/complete: immediate commit + single bottom Undo snackbar

## Goal

Replace the todo app's "acted-on row lingers struck-through, then commits ~5s
later" interaction with **immediate commit + a Todoist-style Undo snackbar**. Fix
the bug where navigating away (switching tabs) before the window elapses drops the
write. Apply to **web and mobile**.

## Decisions (all locked with the user)

- **Scope:** web (`apps/agent-web`) and mobile (`apps/agent-mobile`) together — the
  interaction and the `useUndoableLeave` hook are duplicated on both, and the
  silent-cancel bug exists on both.
- **Commit timing:** every action commits its optimistic write **immediately** and
  the row **leaves the list at once**. No deferred window. Retire `useUndoableLeave`
  and the `project-leave.ts` detail→list handoff entirely.
- **Undo affordance (Home task-complete only):** a **single global snackbar** (the
  existing toast controller in `@zero/agent-core`). Undo **calls the server** to
  reverse the action. Only **one toast at a time**: a second action replaces the
  first (use a fixed toast id, e.g. `id: "undo"`, so `show` replaces in place; the
  first action just becomes unavailable — its write already committed, so nothing
  needs to auto-fire).
- **Toast position:** **bottom** of the screen (like Todoist), on both surfaces.
  Currently mobile shows it at the top; move it. On mobile it must sit above the
  tab bar (use safe-area bottom inset + tab bar height).
- **Projects get NO Undo toast** (decided after checking the trigger path): both
  "Mark done" and "Delete project" live only in the detail screen's ⋯ actions sheet
  (open project → ⋯ → action = 3 deliberate taps). A mis-tap is very unlikely, so an
  Undo net is low value there — and the delete-restore path is the single most
  invasive change in the codebase (a pre-formed-row insert in the shared collection
  factory plus a `createdAt`-aware server add). Not worth it. Projects done/delete
  just **commit immediately** with no toast. This still fixes both original
  complaints for projects (no lingering ghost row, no tab-switch cancel) because the
  fix is the immediate commit, not the toast.
- **"+ Waiting" inline shortcut** on Home (only shown during the old completion
  window) is removed. Adding waiting conditions stays on the project screen. A
  single-action toast cannot also host "+ Waiting"; this is accepted.

## Compensating writes (what Undo calls)

Undo exists for **one** action: Home task-complete (a genuinely one-tap, mis-tappable
control). Projects commit with no Undo.

| Action | Commit | Undo | New server work? |
|---|---|---|---|
| Task complete (Home) | `api.complete(id)` | **reopen** (set `completedAt = null`) | Yes — new reopen verb end-to-end |
| Project done | `setStatus(id,'done')` | none | No |
| Project delete | `api.remove(id)` | none | No |

### Task reopen (new, mirrors complete)

- Server: `POST /api/tasks/{id}/reopen` beside `/api/tasks/{id}/complete`
  (`apps/agent-api/src/routes/tasks.ts`); store method mirroring the complete
  method, setting `completedAt = null` (`apps/agent-api/src/store/tasks.ts`).
- Client REST: `reopenTask(getToken, id)` in `apps/agent-mobile/src/lib/api.ts`
  and the web mirror, threaded through `TasksRest`
  (`packages/agent-core/src/tasks/collection.ts`) as a `reopen(id)` **update** verb
  (draft sets `completedAt = null`; it re-enters the open-tasks working set).
- The Home list is `homeTasks` (open tasks). Reopening re-inserts the row; the
  collection's `leavesCollection`/`matches` handling must bring it back.

The shared `base.ts` collection factory is **not** touched by this plan (the
pre-formed-row insert was only needed for project restore, which is now dropped).

## What to change (by file)

- **Shared hook removal:** delete `useUndoableLeave` from
  `apps/agent-mobile/src/lib/screen-hooks.ts` and
  `apps/agent-web/src/lib/screen-hooks.ts` once no call site uses it; drop the
  `list-row` test usage; retire `DONE_UNDO_MS`
  (`packages/agent-core/src/projects/display.ts`) if nothing references it.
- **project-leave.ts** (`apps/agent-mobile/src/lib/project-leave.ts` + web mirror if
  any): remove. With immediate commit + a global toast, the detail screen commits
  and shows the toast itself; no handoff to the list is needed.
- **Home** (`index.tsx` mobile, `HomePage.tsx` web): `onComplete` → immediate
  `complete` + `toast("Completed", { id:"undo", action:{ label:"Undo", onPress: reopen }})`.
  Remove the `leaving` branch, the struck-through row, and "+ Waiting".
- **Projects list** (`projects/index.tsx` mobile, `ProjectsPage.tsx` web): remove
  the `done`/`del` `useUndoableLeave`, the `pending`/`onUndo` wiring, the
  struck-through `ProjectRow` branch, and the `onProjectLeave` subscription. The
  list no longer needs any leave machinery.
- **Project detail** (`projects/[id].tsx` mobile + web equivalent): ⋯ → "Delete
  project" commits `remove` immediately then pops; ⋯ → "Mark done" commits
  `setStatus('done')` immediately then pops. No toast, no `requestProjectLeave`.
- **Toaster position:** `apps/agent-mobile/src/components/toaster.tsx` → anchor to
  bottom (safe-area bottom inset + tab bar height), and the web `<Toaster>` → bottom.
- **agent-core:** `tasks/collection.ts` (reopen verb + `TasksRest.reopenTask`), plus
  the mobile and web `entity-api.ts`/REST wiring for the new `reopenTask` closure.
  `projects/collection.ts` and `collection/base.ts` are unchanged.

## Test strategy

- **Screen tests** (mobile `__tests__/index.test.tsx`, `projects.test.tsx`,
  `project-detail.test.tsx`; web equivalents): rewrite the "after the undo window
  the write commits" cases to "the write commits immediately and the row is gone".
  Add a **navigate-away-immediately** test proving the write still persists (the
  motivating regression) — for Home task-complete and for project done/delete.
- **Home Undo**: toast action present → Undo reopens the task via the compensating
  write and the row returns.
- **Single-toast** test: completing a second task replaces the first toast (one
  visible). The controller already supports id-replacement; assert Home uses one id.
- **Reopen**: unit-test the collection `reopen` verb (row returns to the open set)
  and the route/store (mirror the complete tests, including the server round-trip).
- Remove `useUndoableLeave` / `list-row` Undo tests.

## Documentation

- `docs/todo-app.md`: replace the "undoable-leave (~5s Undo, `DONE_UNDO_MS`)"
  description with the immediate-commit model, and note the single bottom Undo
  snackbar is Home task-complete only.
- Changelogs (same change): `apps/agent-mobile/CHANGELOG.md` and
  `apps/agent-web/CHANGELOG.md` — completing a task, marking a project done, and
  deleting a project now happen right away; completing a task shows a single Undo
  snackbar at the bottom.

## Skills to use

- `tdd` — reopen verb/route (test-first, mirroring the existing complete tests).
- `changelog` — before editing either CHANGELOG.
- `git-commit` — logical commits (server reopen; agent-core reopen verb; Home
  rewire + toast; projects/detail rewire; hook + project-leave removal; toaster
  position; docs).
- `open-pr` — one PR at the end.

## Acceptance criteria

- Completing a task, marking a project done, and deleting a project each remove the
  row **immediately** (no struck-through lingering row) on web and mobile.
- Doing any of those and **immediately switching tabs / navigating away** still
  persists the action (test + on-device).
- Completing a task shows a **single** Undo snackbar at the **bottom**; completing a
  second task replaces it; Undo reopens the task (server call) and the row returns.
- Projects done/delete show **no** toast.
- `useUndoableLeave` and `project-leave.ts` have no remaining references.
- `docs/todo-app.md` and both changelogs updated in the same change.

## Risks

- **Reopen re-entry**: the reopened task must reappear in the open-tasks working set
  and in Home ordering; cover with a collection test.
- **Toast at bottom on mobile** must clear the native tab bar; verify on-device.
