# Plan 2 — Move a loose task to a project

Part 2 of the `todo-single-list` series (see `todo-single-list-overview.md`).
Depends on plan 1 (the merge) being shipped. Self-contained.

## Goal

Let a loose task (no project) be assigned to a project. This is the deliberate
replacement for the **clarify** step the merge removed: the way a raw thought in
your one list becomes project work, without retyping it. After this, a loose
task's exits are complete, postpone, **and assign-to-project**.

## Why this is the next slice

The merge (plan 1) left exactly one gap on purpose: with `process` and Refine
gone, the only ways to clear a loose task were complete and postpone, so a loose
task you wanted to file under a project had to be completed and retyped there.
This plan closes that gap and nothing more. It is small and isolated, which is why
it sits between the merge and the larger availability rework (plan 3).

## What changes

- **A verb that sets `projectId` on a task.** The column already exists (tasks
  carry `projectId`, null = loose). The change is a first-class "move" verb,
  idempotent on the id, that sets (or clears) `projectId`. It rides the existing
  `PATCH /api/tasks/{id}` shape added in plan 1 (one more optional field,
  `projectId`), and a corresponding collection verb + optimistic update.
- **What happens to `takenOnAt` and `sortKey` on move** (decide and document):
  - `takenOnAt`: recommended **cleared** on move into a project. A loose task is
    always on Home; once it belongs to a project it should obey the project's
    curation (taken-on + active) rather than silently staying on Home. Moving it
    out (back to loose) leaves it loose and always-visible.
  - `sortKey`: keep the task's existing key (one global order; see the overview).
    The task simply also becomes a filtered member of the project's slice. No
    re-mint needed.
- **The affordance.** Add it to the **task detail screen** (the plan-1 detail was
  intentionally minimal): a "Project" row that opens a project picker (none / pick
  one). This is the screen the detail was always going to grow a project row on.
  Consider also a row action (swipe or ⋯) later; the detail is enough for v1.

## Surfaces to change

- **Server (`apps/agent-api`):** widen `PATCH /api/tasks/{id}` to accept
  `projectId` (uuid or null); a `DbTaskStore.setProject(id, projectId)` verb;
  `UserDO` RPC; log line. 404 on unknown id, 400 on a malformed project id.
- **Shared (`packages/agent-core`):** a `moveToProject` (or `setProject`) verb on
  `createTasksApi` with an optimistic update; clear `takenOnAt` in the same
  optimistic write per the decision above.
- **Clients:** a Project row + picker on the task detail (web + mobile). Mobile:
  reuse the existing project list/collection for the picker; verify on the
  Pixel 7. Web: mirror.

## Out of scope

- Creating a new project from the picker (pick existing only for v1).
- Bulk move / multi-select.
- Moving a task *between* projects is the same verb; no extra work, but the UI
  copy should read "Move to project", not "Add to project".

## Test strategy

- **Server:** `setProject` sets/clears `projectId`; PATCH validation; idempotent
  replay.
- **Shared:** the collection verb's optimistic update moves the row and clears
  `takenOnAt`; offline replay is safe.
- **Clients:** detail-screen project row renders, picking a project moves the task
  off Home's loose list into the project (and off Home unless taken-on+active);
  Pixel 7 device check on mobile.

## Documentation

- `docs/entities/task.md`: document the move verb and the `takenOnAt`-cleared-on-
  move rule; note it replaces the removed clarify/process step.
- Changelog bullet (mobile + web): "Move a task into a project from its detail."

## Acceptance criteria

- A loose task can be moved into a project and back to loose from its detail
  screen, on web and mobile.
- Moving into a project clears `takenOnAt`; the task then obeys the project's
  curation gate on Home.
- `sortKey` is preserved across the move (no reorder side effect).
- Offline-safe; Pixel 7 device-verified on mobile.
</content>
