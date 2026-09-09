# Fix Undo-restore on device: reviving a row that left the working set

## Bottom line

The Undo action on the bottom snackbar (task-complete and capture-process, on
Home, Upcoming, and now the project screen) does **not** bring the row back on a
real device, even though it does in the unit tests. Root cause: `reopen`/
`unprocess` are modelled as an **update-by-id**, but by the time Undo runs the
persisted collection has already **evicted** the row (the server list is
open-only), so the update throws `CollectionOperationError: key … not found in
the collection` and nothing is restored. The fix is to model the inverse verbs as
a **revive**: an operation that re-inserts the row when it is absent and updates
it when present, carrying the full row (which the toast already has in scope).
One change to the shared collection factory in `@zero/agent-core` fixes all three
surfaces at once. No server change (both `POST …/reopen` and `POST …/unprocess`
already exist and are idempotent).

## How it was found

On-device (Pixel 7, dev client → Metro, dev app points at **production**):
completing a task on the project screen raised the "Completed / Undo" toast
correctly, and tapping Undo at the button's exact coordinates fired
`reopenTask`. But the row never returned, and the device log showed:

```
ERROR CollectionOperationError: The key "5cd2a6d7-…" was passed to update
but an object for this key was not found in the collection
```

## Root cause (persisted vs in-memory divergence)

The data layer has two builders in `packages/agent-core/src/collection/base.ts`:

- **In-memory** (`createInMemoryEntityApi`, the fallback used in jest and private
  browsing): `onUpdate` upserts the server row back and returns
  `{ refetch: false }`. So after `complete`, the completed row **stays** in the
  collection (the live query hides it via `isNull(completedAt)`). `reopen`
  (`collection.update(id)`) finds it → works. **This is the path the unit tests
  exercise, which is why they pass.**
- **Persisted** (`createPersistedEntityApi`, the real device/web path): after an
  `update` verb whose `refetchAfter` is not `false`, the outbox mutationFn calls
  `fetchAndReconcile()`. `complete`/`process` default to `refetchAfter: true`, so
  it re-pulls the **open-only** server list (`listTasks` = `completedAt IS NULL`;
  `listCaptures` = `processedAt IS NULL`) and `reconcileWrites` emits a
  `delete` for the just-completed row (present locally, absent from the server
  list). The row is **evicted**. When Undo runs, `collection.update(id)` throws
  because the key is gone.

So the bug is structural: an update cannot resurrect a row that has left the
working set. It affects the **already-shipped** Home task-complete Undo and
capture-process Undo (2026-09-09) too — their `docs/todo-app.md` note says mobile
device verification was still pending, and the in-memory unit tests could not
catch it. The project-screen work merely extended the same broken pattern.

## Why not the minimal "don't evict" fix

Setting `refetchAfter: false` on `completeTask`/`processCapture` would make the
persisted path retain the row like in-memory, and `reopen`/`unprocess` would then
find it. **Rejected as fragile:** any *other* refetch-triggering write during the
~4s Undo window evicts the retained row again — e.g. an `add` (insert verbs
always `fetchAndReconcile`) or a foreground refetch (`useForegroundRefetch`). On
Home, complete-then-quick-add is a realistic sequence. The Undo would silently
break again. We want a fix that does not depend on the row lingering.

## The fix: a `revive` verb

Model `reopen`/`unprocess` as the inverse of `leavesCollection` — a row
**re-enters** the working set:

- **Carries the full row.** The Undo closure already has the entity in scope
  (Home/Upcoming pass `item: Task`/`Capture`; the project screen currently passes
  only `tid` and must be changed to pass the `Task`). So the api method changes
  from `reopen(id)` / `unprocess(id)` to `reopen(task)` / `unprocess(capture)`.
- **Optimistic step (`onMutate`)** in both builders:
  - if `collection.has(row.id)` → `collection.update(row.id, clearField)`
    (proper optimistic transaction, rollback on failure),
  - else → `collection.insert(rowWithFieldCleared)` **preserving the row's id**
    (not `mintRow`), which is a proper optimistic insert (rollback on failure)
    and shows the row again immediately.
- **Persist + reconcile** unchanged in spirit: call the same idempotent REST
  (`rest.reopenTask(id)` / `rest.unprocessCapture(id)`), then `reconcileOne` the
  server row (now in the working set) so it stays after the overlay drops.

### Why the two-path routing resolves cleanly

The two builders route a write differently, and revive can appear as either an
insert (row already evicted) or an update (Undo tapped before eviction), so
routing must not depend on the op type alone:

- **In-memory** routes by *operation type* (`onInsert`/`onUpdate`, `base.ts`
  ~320/332). The row is **not** guaranteed present: the in-memory builder is
  `queryCollectionOptions` over the open-only `spec.fetch()`, and `refetch()`
  (wired via `useForegroundRefetch`) reconciles the collection to that open-only
  result, so a foreground refetch between complete and Undo evicts the row here
  too — after which revive's optimistic `collection.insert` lands in `onInsert`,
  which today routes to the single **add** verb (`insertVerbOf`) and would create
  a new row instead of reopening. **So the revive op MUST carry per-operation
  metadata `{ verb: name }`** (`collection.insert(row, { metadata })` /
  `collection.update(id, { metadata }, draft)`, both supported in
  `@tanstack/db@0.8.5`; the value surfaces as `PendingMutation.metadata`), and
  `onInsert`/`onUpdate` must route by that metadata when present: a
  metadata-named revive verb wins over the default add/`routeUpdate` path. Keep
  the changed-field `routeUpdate` as the fallback for the plain update verbs, but
  **widen it to consider `revive` verbs alongside `update` verbs in one
  declaration-ordered pass** — the order is load-bearing (complete/process
  `matches` a *set*, their inverse `matches` a *clear*; the inverse must stay
  declared after so a clear routes to revive, not to complete/process).
- **Persisted** routes the outbox by *verb name* (`mutationFnName`,
  `base.ts:589`), independent of whether the optimistic op was an insert or an
  update. Add a `revive` branch to the executor loop that calls
  `verb.persist(String(m.key), …)` and `reconcileOne(updated)` — identical to the
  `update` branch, so it does the right thing whether the optimistic op was an
  insert (row was evicted) or an update (Undo tapped before eviction). Keep
  `refetchAfter` semantics (revive should refetch: the open list now includes the
  row, so it is retained).

Net: the only genuinely new code is (1) a `revive` verb kind (or an `update`
flavour flagged `revives: true` carrying a `row(args)` builder), (2) the
present/absent optimistic branch in both builders' action wiring, (3) widening
`routeUpdate` to include revive verbs, and (4) the executor `revive` branch on the
persisted path. `undoableAction` itself does not change (it still just calls
`undo()`), only the `undo` closures at the call sites (`() => api.reopen(item)`).

### Verb shape (illustrative)

```ts
// tasks/collection.ts — reopen becomes a revive that carries the row
reopenTask: v.revive<Task>({
  id: (task) => task.id,
  row: (task) => ({ ...task, completedAt: null }), // full row, id preserved
  draft: () => (draft) => { draft.completedAt = null; }, // present-case update
  matches: ({ changes }) => "completedAt" in changes,     // in-memory routing
  persist: (id) => rest.reopenTask(id),
}),
```

`unprocessCapture` mirrors it with `processedAt`.

## System-wide impact

- **API surface change:** `TasksApi.reopen` and `CapturesApi.unprocess` take the
  row, not the id. Call sites: `undoableAction({ undo: () => api.reopen(item) })`
  on Home/Upcoming/project (project's `onComplete` must receive the `Task`, a
  small prop/closure change in `ProjectTasks` on both surfaces).
- **Projects** are unaffected: `done`/`delete` use `leavesCollection`/delete and
  have no Undo by design.
- **No server change.** Both inverse endpoints exist and are idempotent, so an
  offline replay is safe.
- **Completed/processed rows** briefly retained by revive are still hidden by the
  live queries (`isNull(completedAt)` / `isNull(processedAt)`); a later
  foreground refetch or cold start cleans them from the base as today.

## Test strategy

The bug lives on the **persisted** path, which the node/jest suites cannot run
(no native SQLite / no op-sqlite). So:

- **In-memory unit tests (agent-core):** keep/extend the present-case — complete
  then reopen restores the row; process then unprocess restores it. These already
  pass and must keep passing after the verb becomes `revive` (they exercise the
  update branch).
- **Executor-branch unit test (agent-core, new):** drive the persisted executor's
  `mutationFns[verb]` with a fake executor (the injected `startOfflineExecutor`
  can capture `config.mutationFns`) to assert the `revive` branch calls the
  reopen/unprocess persist (and NOT the add persist) — a headless regression
  guard for the exact routing that broke. Note the scope limit: `reconcileOne`
  early-returns until the sync's `controls` are set on first subscribe
  (`base.ts` ~450/509), so asserting the reconcile *insert* needs either starting
  the sync in the harness or extracting the per-verb executor step into a pure
  function taking `controls`. Scope the test to persist-routing unless that
  extraction is done.
- **In-memory metadata-routing test (agent-core, new):** simulate the eviction
  (complete, then `refetch()` against an open-only fake REST so the row leaves),
  then revive and assert it reopens (not adds) — this is the one place the F1
  metadata routing is unit-observable, since the in-memory path runs in node.
- **On-device (Pixel 7), required** per the new `AGENTS.md` rule: complete a task
  on Home, Upcoming, and the project screen; tap Undo within the window; confirm
  the row returns and the device log shows `reopenTask` with **no**
  `CollectionOperationError`. Repeat for capture process/unprocess. Verify the
  fragile sequence too: complete → add another task → Undo still restores.
  Because the dev app hits **production**, restore/clean any rows touched. Use
  `maestro hierarchy` to read the toast's live `bounds` and `adb shell input tap`
  its centre (Maestro's `tapOn` can miss the 4s toast — see AGENTS.md).

## Documentation

- `docs/storage.md` — document the working-set model and the revive verb (the
  inverse of `leavesCollection`): a row can leave the working set on a write and
  be revived by carrying its full row, and why an update-by-id cannot resurrect an
  evicted row. This is the durable design record.
- `docs/todo-app.md` — correct the 2026-09-09 Undo entries' implicit claim: note
  that Undo-restore did not work on device until this fix, now verified.
- Changelogs (todo app, not agent-api): `apps/agent-mobile/CHANGELOG.md` and
  `apps/agent-web/CHANGELOG.md` — one dated bullet each, user-facing, e.g. "Undo
  now actually brings a completed task / processed capture back" (only if the
  shipped ones were user-visibly broken — they were).

## Skills to use

- **investigate** — confirm the fix on-device against the exact log signature
  (`CollectionOperationError` gone; `reopenTask`/`unprocessCapture` fires and the
  row returns).
- **deep-modules / vocabulary** — the change lives behind the collection
  factory's interface; `revive` is a first-class verb kind alongside
  insert/update/delete, not leaked to screens.
- **tdd** — in-memory present-case and the new executor-branch test first, then
  the verb change.
- **reproducible-locally** — the persisted path is the point; verification is the
  Pixel 7, not a localhost claim.
- **changelog** — before editing the changelog files.
- **git-commit / open-pr** — commit the shared fix on its own, then the call-site
  wiring; open a PR.

## Acceptance criteria

- On the Pixel 7, tapping Undo after completing a task (Home, Upcoming, project
  screen) restores the row; after processing a capture (Home, Upcoming) restores
  it. Device log shows the inverse verb firing and **no** `CollectionOperationError`.
- The fragile sequence (complete → add → Undo) still restores.
- In-memory unit tests (present-case) pass; a new headless executor-branch test
  guards the revive/absent path; typecheck and lint pass on agent-core, agent-web,
  agent-mobile.
- `docs/storage.md` documents the revive verb and working-set model; the two todo
  changelogs and `docs/todo-app.md` are updated in the same change.

## Risks / notes

- **Main risk:** the persisted path is not covered by the standard suites, so a
  regression can only be caught on-device or by the new executor-branch test —
  write that test, and keep the AGENTS.md on-device rule.
- **Routing correctness rests on per-op metadata**, not on the row being present.
  Do not fall back to "the row is still there so `update` will find it" — a
  foreground refetch can evict it on either builder (verified against
  `queryCollectionOptions` open-only reconcile). Tag every revive op with
  `{ verb: name }` and route by it.
- Preserving the row's id on the absent→insert branch is essential (use the
  collection's upsert/write path, not `mintRow`); a minted id would create a
  duplicate.
- `undoableAction` and the toast are unchanged; this is purely a data-layer fix
  plus threading the full row from the project screen's complete handler.
```
