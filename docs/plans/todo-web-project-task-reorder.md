# Reorder tasks in a project on the web

## Bottom line

Make the Tasks region of `/projects/:id` sortable with a drag handle and keyboard controls. Reuse the web Home drag pattern and the existing Task order and write interface. A drop changes one task's global `sortKey`, immediately reorders the visible project list, and persists across navigation and refresh. No new storage field, Worker route, or migration is needed.

This plan concerns **tasks inside one project's workspace**, not the ordering of projects on `/projects`.

## Current state and decisions

- `apps/agent-web/src/pages/ProjectDetailPage.tsx` renders `ProjectTasks` from the shared open-task collection, ordered by `createdAt`; it filters by `projectId` and offers completion and date chips, but no reorder handle. The section disappears when the project has no tasks. The main `+ Add` drawer can create an undated task even when the section is absent.
- `apps/agent-web/src/pages/HomePage.tsx` already uses `@dnd-kit/core` and `@dnd-kit/sortable`: pointer and keyboard sensors, a handle-only drag, `arrayMove`, `orderKeyBetween` for the moved row's neighbors, and `TasksApi.reorder` with persistence-error reporting. Keep its completion, edit, and Tomorrow controls unchanged.
- `@zero/agent-core` exports `compareByOrder`, `orderKeyBetween`, and the offline-durable `TasksApi.reorder`. The server accepts the existing `PATCH /api/tasks/{id} { sortKey }`. The Task entity defines **one global order**; Home and project screens are filtered views of it. Mobile already reorders a filtered project slice using that same order.
- Sort the visible project subset with `compareByOrder`, not `createdAt`, and mint the key between the moved row's new **visible project-task** neighbors. Other projects' tasks and loose tasks must not be drag targets or influence the key calculation. Their keys do not change. Interleaving in the global order is acceptable; the moved row's placement in the filtered project slice is what the user chose.
- Keep the drag handle separate from the completion circle and date chip. Match Home's Space/arrow/Space keyboard interaction, focus style, pointer behavior, and sortable transforms. Reuse the existing dnd-kit packages; do not invent a second persisted order.
- Keep the existing project page structure and Task row presentation. The list remains visible for all open project tasks, including undated and future-dated ones; reordering must not change membership, show-up dates, completion, or derived Project status.
- Prefer a local adaptation of Home's small drag wiring in `ProjectTasks` over a premature generic row/list abstraction: the two screens have different row actions and list semantics. If implementation exposes a substantial shared invariant, extract a deep private web module that owns sensors, drop/key calculation, and the sortable handle for both callers, rather than passing dnd-kit internals through a shallow wrapper. Do not refactor Home's behavior solely to ship this feature.

## Implementation steps

1. **Project tasks display the persisted manual order.** In `ProjectTasks`, sort the filtered open project tasks with `compareByOrder` (without mutating the live-query array). Preserve the empty-section rule, local add control, completion circle, and `TaskDateChip`.
2. **A project task can move by its handle.** Wrap only the Tasks list in a `DndContext` and `SortableContext` with the Home pointer/keyboard sensors and vertical-list strategy. Add a task-id-based sortable row and a labeled, focusable grip. On a valid drop, compute the moved row's new neighbors from the sorted project subset, call `api.reorder(id, orderKeyBetween(prev, next))` once, and report rejected persistence through the existing `onError` path. No-op on drop outside the list or onto itself. Keep dragging isolated from date picking and completion.
3. **The behavior is covered through the project page.** Extend `apps/agent-web/src/pages/ProjectsPage.test.tsx` using its existing in-memory Tasks collection and REST stand-in. Include keyed tasks whose `createdAt` order differs from `sortKey`, an interleaved other-project task, and both undated and future-dated project tasks. Assert the visible order and membership. Drive a drop through a test adapter for dnd-kit's DOM sensor (jsdom lacks reliable layout) and assert one moved-row write, the new order after persistence/refetch and leaving/reopening the project, and no write for an invalid or same-item drop. Check head, middle, and tail insertions as useful; keep tests at the screen interface rather than testing a private key helper. Assert completion and date controls still work independently. Verify a rejected write reaches the page error display.
4. **User-facing documentation ships with the change.** Add a most-recent-first, dated user-perspective bullet to `apps/agent-web/CHANGELOG.md`. Update the web UI description in `docs/entities/task.md` and the relevant project-workspace description in `docs/entities/project.md` only where needed; record the shipped increment in `docs/todo-app.md`. Keep ordering mechanics in the Task entity document rather than duplicating them in multiple docs.

## Verification

- Run `gob run bin/ci` as the repository-wide check. On the documented NixOS host, whole-repo CI can fail when host `workerd` starts; also run `pnpm --filter @zero/agent-web run test`, `lint`, `typecheck`, and `build` directly and report the exact results.
- In a browser against a suitable running web app with non-production throwaway data, verify pointer drag and Space/arrow/Space keyboard reorder, refresh and route-away/back persistence, head/tail placement, and that the complete/date buttons still respond. The DOM test adapter does not prove the real dnd-kit sensors. Do not mutate production user tasks just to prove the gesture.

## Out of scope

- Reordering projects, Waiting conditions, or After relationships.
- Dragging tasks across projects, Home, or Upcoming; adding per-project sort keys.
- Changing the task editor, scheduling semantics, Worker, schema, mobile UI, or the Home drag behavior.

## Acceptance criteria

- Every open task in the selected project appears in `sortKey` order regardless of date; no other project's task appears.
- A handle drag or keyboard move updates the visible order immediately and persists after refetch and revisit; only the moved task receives a reorder write.
- Completion, date picking, local add, and empty-section behavior remain intact; invalid drops do nothing; write failures remain visible.

## Skills to use during implementation

- `vocabulary` and `deep-modules` — choose the smallest useful seam if drag logic is shared.
- `testing` — design screen-level behavior tests with a DOM sensor stand-in.
- `documentation` — update entity and tracking documents without duplicating facts.
- `changelog` — load before editing the web changelog.
- `browse` — verify real pointer and keyboard gestures in the browser.
