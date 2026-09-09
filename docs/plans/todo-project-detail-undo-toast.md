# Undo toast for completing a task on the project detail screen (+ extract the undoable-action helper)

## Bottom line

Completing a task from the **project detail** screen is the one remaining
place — on either surface — that commits a done/process action with **no** Undo
snackbar. The rest already shipped (Home task-complete, Home capture-process,
Upcoming capture-process; PRs #75/#76). Rather than copy the toast wiring a fourth
time, extract the now-repeated shape into one small React-free helper in
`@zero/agent-core`, migrate the three existing call sites, then wire the
project-detail handlers as the fourth caller. Extract-first, so the feature change
is a trivial one-liner and the "only ever one Undo on screen" guarantee becomes an
enforced invariant instead of a copy-pasted magic string.

## Background (so a fresh agent can decide well)

- The toast system is our **own primitive**, not a library: a headless controller
  in `@zero/agent-core` (`src/toast/controller.ts`) owns id minting, queueing,
  de-duplication/replacement by id, timers, and an observable snapshot, behind a
  tiny `toast()` + `<Toaster>` interface. Each surface renders the snapshot through
  its own `<Toaster>` (web DOM+CSS at `apps/agent-web/src/components/Toaster.tsx`;
  mobile RN+reanimated at `apps/agent-mobile/src/components/toaster.tsx`), both
  mounted globally (`apps/agent-web/src/App.tsx`, `apps/agent-mobile/src/app/_layout.tsx`),
  so a `toast()` call from any screen renders. See `docs/plans/toast-primitive.md`.
- The current model (shipped 2026-09-09): done/process actions **commit
  immediately** (the row leaves at once) and raise a single bottom Undo snackbar.
  A **fixed toast id `"undo"`** means a second action replaces the first toast, so
  only one Undo is ever offered. Undo runs the inverse verb:
  - task complete ↔ `reopen` (`POST /api/tasks/{id}/reopen`)
  - capture process ↔ `unprocess` (`POST /api/captures/{id}/unprocess`)
- The collection verbs (`api.complete`, `api.reopen`, `api.unprocess`, …) return a
  TanStack DB `Transaction`; a page surfaces a write error via
  `tx.isPersisted.promise.catch(...)`. `messageOf` (error → string) is already
  exported from `@zero/agent-core` (`src/errors.ts`).
- `@zero/agent-core` must stay **React-free** (a workspace lib that calls React
  hooks resolves its own React copy and trips rules-of-hooks). The helper below
  uses no hooks — only `toast` and `messageOf` — so it belongs in agent-core.

## The repeated shape (four call sites)

Home task-complete (`apps/agent-web/src/pages/HomePage.tsx` ~L286,
`apps/agent-mobile/src/app/(signed-in)/index.tsx` ~L356), Home capture-process
(HomePage ~L385, index ~L734), Upcoming capture-process
(`apps/agent-web/src/pages/UpcomingPage.tsx` ~L68,
`apps/agent-mobile/src/app/(signed-in)/upcoming.tsx` ~L104), and the
project-detail task-complete being added (`ProjectDetailPage.tsx` ~L513,
`projects/[id].tsx` ~L596) all repeat:

```ts
const tx = api.<verb>(id);
tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
toast("Completed", {
  id: "undo",
  action: { label: "Undo", onPress: () => {
    const back = api.<inverse>(id);
    back.isPersisted.promise.catch((e) => onError(messageOf(e)));
  } },
});
```

Only three things vary: the message, the forward verb, the inverse verb. The
fixed `"undo"` id, the double tx-promise error catching, and the action wiring are
invariant. The strongest reason to extract is that invariant: "one undoable-action
toast at a time" currently lives as a copy-pasted string literal in multiple files
(a fifth caller quietly typing a different id would break it). Extracting encodes
it once.

## Goal

Completing a task from the project detail screen (web + mobile) commits
immediately and raises the same single bottom Undo snackbar used elsewhere; Undo
reopens the task. The done/process-with-Undo wiring lives in one deep module that
every caller shares.

## What to change and why

### 1. Extract `undoableAction` into `@zero/agent-core` (internal refactor, no user-facing change)

New module `packages/agent-core/src/toast/undoable.ts`:

```ts
import type { Transaction } from "@tanstack/db";
import { messageOf } from "../errors";
import { toast } from "./controller";

// Commit an optimistic action immediately, then raise the single shared Undo
// snackbar whose action runs the inverse verb. The fixed "undo" id is owned here,
// so only one undoable-action toast is ever on screen, app-wide. Both tx promises
// route failures to onError. React-free: safe in agent-core.
export function undoableAction(opts: {
  message: string;                     // e.g. "Completed"
  act: () => Transaction;              // () => api.complete(id)
  undo: () => Transaction;             // () => api.reopen(id)
  onError: (message: string) => void;
}): void {
  opts.act().isPersisted.promise.catch((e) => opts.onError(messageOf(e)));
  toast(opts.message, {
    id: "undo",
    action: {
      label: "Undo",
      onPress: () =>
        opts.undo().isPersisted.promise.catch((e) => opts.onError(messageOf(e))),
    },
  });
}
```

Export it from `packages/agent-core/src/index.ts`.

This is a category-1 (in-process) seam: no new port, no adapter — the network hop
stays hidden inside the existing `TasksApi`/`CapturesApi` REST adapters. It is a
deep module by the deletion test: delete it and the wiring reappears verbatim in
four places.

### 2. Migrate the three existing call sites to `undoableAction`

Replace the inline blocks in HomePage/index (task-complete and capture-process)
and Upcoming (capture-process) with one call each, e.g.:

```ts
undoableAction({ message: "Completed", act: () => api.complete(item.id), undo: () => api.reopen(item.id), onError });
// capture: act: () => api.process(item.id), undo: () => api.unprocess(item.id)
```

Keep the exact user-facing behavior (same message, same shared id). No changelog
entry for this step — it is a pure refactor.

### 3. Wire the project-detail handlers (the actual feature)

- **Web** — `apps/agent-web/src/pages/ProjectDetailPage.tsx`, `ProjectTasks.onComplete` (~L513).
- **Mobile** — `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`, `ProjectTasks.onComplete` (~L596).

Both currently fire `api.complete(tid)` and swallow errors but never toast. Replace
with:

```ts
undoableAction({ message: "Completed", act: () => api.complete(tid), undo: () => api.reopen(tid), onError });
```

`api.reopen` is already on the `TasksApi` passed into `ProjectTasks`; the global
`<Toaster>` already renders over the project-detail route. No API, collection, or
mount work. There is no capture-process action on this screen (captures don't
appear there), so tasks are the only gap.

## Sequencing

Extract-first (steps 1→2→3). It satisfies the Rule of Three at the moment there are
four real callers with a stable, just-shipped pattern, converts the fragile
shared-id convention into an enforced invariant, and makes the feature change a
one-liner.

## Tests to add or update

Replace, don't layer — assert through interfaces on observable outcomes.

- **agent-core**: new `packages/agent-core/src/toast/undoable.test.ts` — with a
  fake toast controller/spy and stub transactions: `act` is called; a toast with
  the shared `"undo"` id and an Undo action is shown; tapping Undo runs `undo`; a
  rejected `act`/`undo` promise routes to `onError`. This is the primary test
  surface for the extracted logic.
- **Web**: the existing `HomePage.test.tsx` and `UpcomingPage.test.tsx` reopen/
  unprocess cases keep passing after migration (they assert the screen behavior,
  which is unchanged). Add a ProjectDetail page test (mirror `HomePage.test.tsx`
  reopen mock at ~L165): completing a project task shows the "Completed" toast and
  Undo calls `reopenTask`. The existing per-page suites can shrink to "the screen
  calls the action," since the toast mechanics are now covered in agent-core.
- **Mobile**: `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx`
  currently stubs `reopenTask: () => Promise.reject(...)` (unused) — wire a real
  spy and add a test mirroring the Home one at `index.test.tsx:356` ("completes a
  task immediately and offers Undo in a toast that reopens it"). Existing Home/
  Upcoming mobile tests keep passing after migration.

## Docs to add or update

- `docs/todo-app.md` — extend the 2026-09-09 Undo-snackbar entries with a short
  follow-up: completing a task on the **project detail** screen now raises the same
  single bottom Undo snackbar (reopens the task). User-facing wording, no internals.
- `apps/agent-api/CHANGELOG.md` — the completion/Undo behavior ships to agent users
  (this file is surfaced in-product), so add one dated, user-facing bullet in the
  same change. Match the wording/placement of the earlier snackbar entry. The
  extraction step (1–2) gets **no** entry (purely internal).

## Skills to use

- **tdd** — write the failing `undoableAction` test first, then the migration, then
  the project-detail test before wiring the handlers.
- **deep-modules / vocabulary** — the extraction is the design core: one deep module
  behind the `undoableAction` interface, category-1 in-process seam, no new port.
- **changelog** — before editing `apps/agent-api/CHANGELOG.md`.
- **git-commit** — commit the internal extraction (steps 1–2) separately from the
  feature (step 3) for a clean history.
- **open-pr** — to send for review.

## Acceptance criteria

- Completing a task on the project detail screen (web and mobile) removes the row
  immediately and shows a bottom "Completed" snackbar with an **Undo** action;
  tapping Undo reopens the task via `POST /api/tasks/{id}/reopen`.
- Only one Undo snackbar is ever visible app-wide — completing/processing anything
  else replaces it (the shared `"undo"` id now lives in `undoableAction`, not in
  any screen).
- Home and Upcoming behavior is byte-for-byte unchanged after migrating to
  `undoableAction` (existing tests green).
- `undoableAction` has its own agent-core unit test; new project-detail tests on
  both surfaces cover toast-shown and Undo-reopens; all suites pass.
- `docs/todo-app.md` and `apps/agent-api/CHANGELOG.md` updated in the same change.

## Notes / risks

- The handlers receive the task **id** (`tid`), not the full `Task`; use it
  directly (`api.complete(tid)` / `api.reopen(tid)`) — no signature change.
- Mobile is a pure-JS change (no new native module), so it hot-reloads on the dev
  client; a quick Maestro/Pixel-7 check of the Undo on the project screen is worth
  noting in the PR but no EAS rebuild is required.
- Keep `messageOf` and the tx-promise error routing inside the helper so callers
  can't drift on error handling.
</content>
