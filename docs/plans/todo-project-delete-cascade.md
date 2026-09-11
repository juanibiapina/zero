# Auto-delete a project's tasks (and waiting conditions) when the project is deleted

## Goal

Deleting a project permanently removes every task and waiting condition that
belongs to it, on both surfaces (mobile + web), so no orphaned rows survive a
project delete. When done: after a project is deleted, `GET /api/tasks` no longer
returns any task with that `projectId`, no open waiting condition references it,
loose tasks and other projects' tasks are untouched, and neither surface shows a
lingering ghost task.

## Why

A project delete today only removes the `projects` row
(`DbProjectStore.delete` → `DELETE /api/projects/{id}`). Its tasks keep their
`projectId` pointing at the now-missing project, and its waiting conditions keep
theirs. Both are orphaned:

- **Tasks become invisible ghosts.** `homeTasks` (in `@zero/agent-core`) gates a
  project task on `byId.get(t.projectId)` resolving to an `active` project; a
  missing project returns `false`, so the task is hidden from Home. It is not
  loose (it still has a `projectId`), so it lives nowhere the user can reach on
  Home — but it is still an open row the server returns, and a **future-dated**
  orphan still appears in **Upcoming**, which applies no project gate
  (`upcomingSections`). The user sees a task under no project, unable to file or
  finish it cleanly.
- **Waiting conditions** carry `projectId NOT NULL` and are the same orphan
  problem (they are project-scoped by construction).

This is the Minecraft-block rule from `docs/todo-app.md`: introducing/removing an
entity forces a deliberate pass over how it interacts with every other entity.
Project delete must clean up every row that references the project.

## What to change and why

### Server (authoritative cascade)

The cascade lives in the **`UserDO` composition root**, not in
`DbProjectStore`. Each per-entity store owns exactly one table (the per-entity
store philosophy in `docs/todo-app.md`); `DbProjectStore` holds only the
`projects` handle and must not reach into `tasks`/`waiting_conditions`. `UserDO`
already holds all three stores and is where existing cascades live (e.g.
`DbStore.deleteConversation` deletes messages / pendingMessages / schedules by
`conversationId`). Give each dependent store a bulk-by-project verb and have
`UserDO.deleteProject` orchestrate:

- **`DbTaskStore.deleteByProject(projectId): number`** — `db.delete(tasks, {
  where: eq("projectId", projectId) })`, returning the row count. Mirrors the
  existing `db.delete(..., { where: eq("<fk>", ...) })` pattern in
  `store/db.ts`. Deletes every task of that project, open or completed (a
  completed task of a deleted project is just as orphaned).
- **`DbWaitingConditionStore.deleteByProject(projectId): number`** — same shape
  over `waiting_conditions`.
- **`UserDO.deleteProject(id)`** — call `projects.delete(id)`, then
  `tasks.deleteByProject(id)`, then `waitingConditions.deleteByProject(id)`,
  regardless of whether the project row existed (idempotent: a replayed offline
  delete finds nothing and no-ops on all three). Return value stays whatever the
  route needs (today it ignores it; the route always returns 204).

The `DELETE /api/projects/{id}` route (`routes/projects.ts`) is unchanged in
shape — still 204, still idempotent, no 404 — because the cascade rides inside
`userDO.deleteProject`. Extend its log line to carry the cascade counts
(`project_deleted` gains `tasks` / `conditions` counts) so a delete is
observable in Workers Logs.

No migration: no schema change. `tasks.projectId` and
`waiting_conditions.projectId` have no index; the tables are per-user and small,
so a filtered full-table delete is fine (do not add an index speculatively).

### Client (immediate visual cleanup)

Both project-detail screens already hold `tasksApi` and `waitsApi`
(`apps/agent-web/src/pages/ProjectDetailPage.tsx`,
`apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`). After the project
delete transaction persists, **refetch the tasks and waits collections** so the
server's cascade (rows now gone) reconciles into the client and any lingering
ghost — notably a future-dated orphan in Upcoming — disappears:

```
const tx = api.remove(project.id);
tx.isPersisted.promise
  .then(() => Promise.all([tasksApi.refetch(), waitsApi.refetch()]))
  .catch((e) => setError(messageOf(e)));
```

The projects collection already drops the project row optimistically via its
`delete` verb; only the *other* two collections need the nudge. Web navigates to
`/projects` immediately; mobile pops. The refetch runs on the shared singletons,
so it completes even as the screen unmounts.

Do **not** optimistically delete each task client-side. That would queue N task
deletes in the offline outbox that duplicate the server's single cascade,
risking conflicting writes. The server cascade is authoritative; the client only
re-pulls.

## Out of scope

- **Offline immediacy of the cascade.** While offline, the project delete is
  queued and the server cascade runs only on reconnect; until then a future-dated
  orphan can still show in Upcoming (Home already hides it — its project is gone).
  This is a narrow edge (delete a project offline, then open Upcoming before
  reconnect); the client refetch closes it on reconnect. Not worth an optimistic
  per-task cascade.
- **Undo.** Project delete has no Undo today (it is three deliberate taps behind
  the ⋯ menu; see the 2026-09-09 redesign in `docs/todo-app.md`), and a faithful
  restore of the project *and* all its tasks/conditions is not worth its cost.
  Delete stays terminal.
- **Any schema/index change.**
- **The agent `create_task` tool and other producers** — unaffected; they write
  tasks, they do not delete projects.

## Test strategy

- **Store unit tests** (`store/tasks.test.ts`, `store/waiting-conditions.test.ts`):
  `deleteByProject` deletes only rows with the matching `projectId`, leaves loose
  tasks (`projectId == null`) and other projects' rows, returns the deleted
  count, and is a no-op (returns 0) for a project with none.
- **Route/interface test** (`routes/projects.test.ts`): the real seam is "delete
  a project", so test through the route. Seed a project with two tasks (one open,
  one completed) and a waiting condition, plus a loose task and a second project
  with its own task. `DELETE /api/projects/{id}` → 204; then assert
  `GET /api/tasks` returns the loose task and the other project's task but neither
  of the deleted project's tasks, and the deleted project's waiting condition is
  gone (via the waiting-conditions list). This is the test that would have caught
  the orphan bug; the leaf store tests support it.
- **Web screen test** (`ProjectDetailPage` suite): deleting a project calls
  `tasksApi.refetch` and `waitsApi.refetch` after the delete persists, and
  navigates to `/projects`.
- **Mobile screen test** (`projects/[id]` suite): same refetch assertion.
- **Device verification (required by `AGENTS.md`)**: on the Pixel 7, create a
  throwaway project with a task and a waiting condition, delete the project, and
  confirm the task does not appear on Home or Upcoming and no orphan lingers. Use
  only throwaway entities against production; delete them when done. Pure-JS
  change (refetch call), so no EAS rebuild.

## Documentation to update

- `docs/entities/project.md` — the **Delete** behavior and **Interactions →
  Other entities**: deleting a project cascades to its tasks and waiting
  conditions.
- `docs/entities/task.md` — a task is deleted when its project is deleted (note
  under Move-to-project / project membership).
- `docs/todo-app.md` — a "Shipped" project-tracking entry.
- **Changelog** (user-facing, todo app): add the same entry, phrased per surface,
  to **both** `apps/agent-mobile/CHANGELOG.md` and `apps/agent-web/CHANGELOG.md`
  (the todo app ships on both). **Not** `apps/agent-api/CHANGELOG.md` — that is
  the Zero assistant's in-product changelog, a different product. This is one
  fact recorded in two surface changelogs by design; flag it so a later wording
  change updates both.

## Skills to use

- `tdd` — write the store and route tests first, then the cascade.
- `changelog` — load before editing either CHANGELOG.md.
- `git-commit` — when committing (code, tests, docs, and changelog together).
- `reproducible-locally` — verify the touched packages directly
  (`pnpm --filter @zero/agent-api run test`, plus lint/typecheck), and device-
  verify on the Pixel 7; this NixOS box cannot run `workerd`/whole-repo CI.

## Acceptance criteria

- `DELETE /api/projects/{id}` removes the project and every task and waiting
  condition with that `projectId`; loose tasks and other projects' rows are
  untouched; the call stays 204 and idempotent (a second delete is a clean
  no-op).
- `GET /api/tasks` returns no task of a deleted project.
- After a delete on either surface, no ghost task appears on Home or Upcoming.
- Store, route, and both screen tests pass; the touched-package suites and
  lint/typecheck pass; Pixel 7 device verification done.
- `project_deleted` log carries the cascade counts.
- Entity docs, `docs/todo-app.md`, and both changelogs updated in the same change.
```

