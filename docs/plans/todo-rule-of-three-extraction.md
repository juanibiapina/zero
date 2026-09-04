# Rule-of-Three extraction (after Project slice A, before slice B)

Status: **shipped** — merged to `main` in #66 (2026-09-04, squash `b588ced`).
The shape below is what shipped; the two deviations from the first draft are that
a verb's key in the table **is** its outbox mutationFn name (so the durable
contract is unavoidable, no separate `mutationFnName` option) and that verbs are
declared through typed constructors (`verbsFor<Row>().insert<Args>(…)` /
`.update<Args>(…)`) so entity files carry no type annotations of their own. One
acceptance item is still open: the Pixel 7 offline-replay pass on the persisted
path (no CI test; pure JS, a Metro reload suffices) has not been run.

Internal refactor, no user-visible change, no changelog entry. This is the
"Follow-up (NOT a vertical slice)" named in `docs/plans/todo-project-entity.md`
and tracked as "now due" in `docs/todo-app.md` and `docs/entities/project.md`.

## Goal

Three entities (Capture, Task, Project) now exist as deliberate structural
siblings at every client layer. Collapse the **plumbing** they triplicate into one
deep module per layer, keep every **domain verb** per entity, and keep every
public interface the screens consume (`CapturesApi`, `TasksApi`, `ProjectsApi`,
route handlers, hooks) unchanged so no screen or route test moves.

Done means: `packages/agent-core/src/*/collection.ts` shrink from ~1,440 lines to
per-entity files that hold only types, verbs, and a spec (~80–150 lines each);
one `listView`; one mobile and one web wiring helper; all existing package tests,
typecheck, and lint green on `@zero/agent-core`, `@zero/agent-web`,
`@zero/agent-mobile`, `@zero/agent-api`.

## What to extract, and what to leave alone

Extract (identical across all three, verified by reading the files):

1. **The offline collection factory** (`packages/agent-core/src/*/collection.ts`):
   `messageOf`, the pure `*ReconcileWrites` diff, `writeUtils`, `reconcile`, the
   in-memory Query Collection builder, the persisted builder (sync controls,
   load-error channel, `reconcileOne` / `reconcileList` / `fetchAndReconcile`,
   `markReady`-from-snapshot sync, outbox executor, `createOfflineAction`
   wrappers), and the `create*Api` persistence-then-fallback wrapper. Also the
   **id/createdAt convention**: every `optimistic*` mints `id: safeRandomUUID()`
   and `createdAt: now`.
2. **The `*View` count-gate** (`captures/view.ts`, `tasks/view.ts`,
   `projects/view.ts`): byte-identical bodies.
3. **Mobile wiring** (`apps/agent-mobile/src/lib/*-collection.ts`,
   `use-*-api.ts`): the token-getter module ref, the singleton + test reset, and
   the persistence/`startExecutor` stash trick are copy-pasted per entity.
4. **Web wiring** (`apps/agent-web/src/lib/*-collection.ts`): the singleton over
   `queryClient` + `getAppPersistence` + `startOfflineExecutor` + `console.warn`.

Leave alone (per `docs/todo-app.md`, the Minecraft-block rule):

- **Domain verbs and their optimistic drafts** (`process`, `complete`,
  `setStatus`, `edit`, `reschedule`, `reorder`, and how each maps to a REST call).
  They stay in the entity file as the spec's `verbs`.
- **REST contract types** (`CapturesRest`, `TasksRest`, `ProjectsRest`) and the
  per-surface REST modules (`lib/captures.ts`, `lib/api.ts`).
- **Server stores** (`DbCaptureStore` / `DbTaskStore` / `DbProjectStore`) and
  routes. do-orm already is the generic layer; the remaining overlap is two
  3-line idioms (dedupe-on-id add; update-then-get). Not worth a base. Their
  "Rule of Three" comments get updated to say the client extraction happened and
  the server stays per-entity on purpose.
- **Pure per-entity helpers** (`captures/dates.ts`, `order.ts`, `upcoming.ts`,
  `tasks/today.ts`, `projects/sections.ts`): domain, untouched.

## Technical approach

### 1. `packages/agent-core/src/collection/` — one deep module

New folder `collection/` with `base.ts` (+ `base.test.ts`). It exports:

```ts
// The interface every entity collection presents. Screens never see this type;
// each entity re-wraps it into its existing CapturesApi / TasksApi / ProjectsApi.
type EntityApi<Row, Verbs> = {
  collection: Collection<Row, string>;
  actions: { [K in keyof Verbs]: (args: ArgsOf<Verbs[K]>) => Transaction };
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

type EntitySpec<Row extends { id: string; createdAt: string }, Verbs> = {
  // "captures" | "tasks" | "projects". Doubles as the persisted collection id
  // (must stay stable: changing it orphans the local table), the react-query
  // key, the outbox `collections` key, the outbox mutationFn prefix, and the
  // warn-message prefix.
  name: string;
  fetch: () => Promise<Row[]>;
  verbs: Verbs; // Record<string, InsertVerb<Row, Args> | UpdateVerb<Row, Args>>
  // Optional: a server row that no longer belongs in the working set is deleted
  // from the synced base instead of upserted (Project: status === "done").
  // Only Projects sets it; Captures and Tasks keep today's upsert behavior.
  leavesCollection?: (row: Row) => boolean;
};

type InsertVerb<Row, Args> = {
  kind: "insert";
  // Entity supplies the domain fields; the base mints id (safeRandomUUID) and
  // createdAt (now). That is the id/createdAt convention, in one place.
  row: (args: Args) => Omit<Row, "id" | "createdAt">;
  persist: (row: Row) => Promise<Row>;
};

type UpdateVerb<Row, Args> = {
  kind: "update";
  id: (args: Args) => string;
  draft: (args: Args) => (draft: Row) => void;
  // In-memory mode routes a collection.update to a verb by the changed field
  // set (m.changes), first match wins in declaration order. The persisted path
  // never needs it: the outbox keys by mutationFn name.
  matches: (changes: Partial<Row>, modified: Row) => boolean;
  persist: (id: string, m: { modified: Row; changes: Partial<Row> }) => Promise<Row>;
  // Default true (every entity refetches after a write today except Project
  // edit, which sets false to avoid a list fetch per blur-commit).
  refetchAfter?: boolean;
};

export function createEntityApi(deps: {
  spec; queryClient; persistence?; startOfflineExecutor?; onWarn?;
}): Promise<EntityApi>;
export function createInMemoryEntityApi(deps): EntityApi;   // for tests
export function createPersistedEntityApi(deps): EntityApi;  // for tests
export function reconcileWrites<Row extends { id: string }>(currentKeys, server): Write<Row>[];
export type { StartOfflineExecutor, WarnFn, Write };
```

Mapping today's code onto the spec (so the refactor is mechanical):

- In-memory `onInsert`: for each mutation, find the (single) insert verb, call
  `persist(m.modified)`, `reconcile({ upsert })`. `onUpdate`: pick the first
  update verb whose `matches(m.changes, m.modified)` is true, call `persist`,
  then upsert or (if `leavesCollection(updated)`) remove. Return
  `{ refetch: false }`, as today.
- Persisted `mutationFns`: one per verb, named by the verb's key, which is
  therefore today's outbox name (`addCapture`, `setProjectStatus`, …; the outbox
  is durable, so these never change). Each narrows nothing: the base casts
  `m.modified as Row` and passes `m.changes`; the entity's `persist` is
  responsible for what it sends. `createOfflineAction` per verb with `onMutate`
  = `collection.insert(rowWithIdAndCreatedAt)` or `collection.update(id, draft)`.
- `actions[verb]` = in-memory: `collection.insert/update` directly; persisted:
  the offline action. Entity file wraps them into its public verb signatures.

Verb order for Captures in-memory routing today: `sortKey` in changes → reorder;
`showUpDate` in changes → reschedule; `processedAt != null` → process; else
edit. Declare the verbs in that order with those `matches` predicates; `edit`'s
`matches` is `() => true` last. Projects: `"status" in changes` → setStatus;
else edit. Tasks: `completedAt != null` → complete.

Persist differences to preserve or consciously change:

- Project persisted `editProject` today sends the whole `title/icon/description`
  from `m.modified`; in-memory sends only `changes`. Unify on **changes** (the
  in-memory comment already argues this is the correct one: an icon-only edit
  must not clobber a title with a stale value). The outbox serializes `changes`
  (`SerializedMutation.changes`), so a replayed edit still has them.
- Persisted paths `await fetchAndReconcile()` after each verb except Project
  edit. `refetchAfter` keeps that.
- Warn prefixes: Task's says `today:`; it becomes `tasks:`. Log-only.

Each entity file then holds: its `Row` type import, its `*Rest` type, its
public `*Api` type (unchanged), its drafts, and:

```ts
export async function createProjectsApi(deps): Promise<ProjectsApi> {
  const api = await createEntityApi({ spec: projectsSpec(deps.rest), ...deps });
  return {
    collection: api.collection,
    add: (title) => api.actions.addProject({ title }),
    setStatus: (id, status) => api.actions.setProjectStatus({ id, status }),
    edit: (id, fields) => api.actions.editProject({ id, fields }),
    offline: api.offline, refetch: api.refetch,
    getLoadError: api.getLoadError, subscribeLoadError: api.subscribeLoadError,
  };
}
```

Keep the existing exported names the apps and tests import:
`createCapturesApi`, `createInMemoryApi`, `createPersistedApi`,
`createTasksApi`, `createInMemoryTasksApi`, `createPersistedTasksApi`,
`createProjectsApi`, `createInMemoryProjectsApi`, `createPersistedProjectsApi`,
`CAPTURES_QUERY_KEY` / `TASKS_QUERY_KEY` / `PROJECTS_QUERY_KEY` (derive from the
spec name; keep the constants exported). The per-entity in-memory/persisted
builders become thin wrappers over the base's, so the existing collection tests
keep running against the same names. Drop `reconcileCaptureWrites`,
`tasksReconcileWrites`, `projectsReconcileWrites` and the `*Write` types in
favor of one `reconcileWrites` / `Write<Row>` (only tests import them; grep
confirmed no app usage).

Move `StartOfflineExecutor` and `WarnFn` out of `captures/collection.ts` into
`collection/base.ts`; keep them exported from `index.ts` under the same names.

### 2. `packages/agent-core/src/collection/view.ts` — one `listView`

```ts
export type ListView = "rows" | "loading" | "empty" | "error";
export function listView(state: { count; isLoading; loadError }): ListView;
```

Delete `captures/view.ts`, `tasks/view.ts`, `projects/view.ts` and their three
tests; add `collection/view.test.ts` (the same four cases, once). Update the
four call sites to `listView`: `apps/agent-web/src/pages/HomePage.tsx`,
`ProjectsPage.tsx`, `apps/agent-mobile/src/app/(signed-in)/index.tsx`,
`projects.tsx`. Do not keep `capturesView` / `todayView` / `projectsView`
aliases: they would be pass-throughs (deletion test).

### 3. Mobile wiring — `apps/agent-mobile/src/lib/entity-api.ts`

One helper that owns the three copy-pasted mechanics:

```ts
export function defineMobileEntityApi<Api extends { collection: { cleanup(): void } }, Rest>(opts: {
  create: (deps: { queryClient; rest: Rest; persistence; startOfflineExecutor; onWarn }) => Promise<Api>;
  makeRest: (getToken: TokenGetter) => Rest;
}): {
  get: (queryClient: QueryClient) => Promise<Api>;   // singleton
  setTokenGetter: (getToken: TokenGetter) => void;
  resetForTest: () => void;
  useApi: () => Api | null;                          // the hook body from use-captures-api.ts
};
```

Inside: the module-ref token getter, the singleton promise, the reset that
cleans up the collection, the `persistence` thunk that dynamically imports
`@tanstack/offline-transactions/react-native`, opens `getAppOutbox()` +
`getAppPersistence()`, and stashes `startExecutor` for the synchronous
`startOfflineExecutor` the shared factory calls (the forward-ref trick that is
currently duplicated three times with the same comment). Keep the fallback
behavior: under jest the native modules throw and the shared factory falls back
to in-memory, so tests need no op-sqlite mock.

`captures-collection.ts`, `projects-collection.ts`, `tasks-collection.ts` become
a few lines each and **re-export the names tests and screens already import**:
`getMobileCapturesApi`, `setCapturesTokenGetter`, `resetCapturesApiForTest`, and
the same for Projects; `createMobile*Api` had no callers and was dropped. The
hook is exported from the same file (`useCapturesApi = captures.useApi`), so
`use-captures-api.ts` / `use-projects-api.ts` were deleted and the three screens
import the hook from the collection module.
The three mobile screen tests (`index.test.tsx`, `upcoming.test.tsx`,
`projects.test.tsx`) call `reset*ApiForTest` and mock `@/lib/api`; they must
pass unchanged. Tasks has no singleton/hook today (it is parked); give it the
same `defineMobileEntityApi` for symmetry but do not add a screen.

### 4. Web wiring — `apps/agent-web/src/lib/entity-api.ts`

Smaller: a `webCollectionDeps()` returning `{ queryClient, persistence: () =>
getAppPersistence(), startOfflineExecutor, onWarn }` plus a `singleton(build)`
helper, so each `*-collection.ts` is `export const getProjectsApi =
singleton(() => createProjectsApi({ ...webCollectionDeps(), rest: {...} }))`.
Move `queryClient` out of `captures-collection.ts` (Tasks and Projects currently
import it from there) into the new module.

### Alternatives considered

- **Class-based `EntityCollection<Row>` with subclass per entity.** Rejected:
  the verbs differ in arity and routing, which classes express worse than a
  declarative verb table, and the existing code is already closure-based.
- **Route in-memory updates by a `verb` tag stamped into the draft** instead of
  `matches` predicates. Rejected: would add a synthetic field to the row and to
  the persisted table; `matches` mirrors today's `m.changes` logic exactly.
- **Extract a server-store base too.** Rejected for now (see "Leave alone").
- **Keep per-entity `*View` aliases for a softer landing.** Rejected: four call
  sites, trivial edit, and aliases fail the deletion test.

## System-wide impact

- No API, schema, or wire change. No native change on mobile (pure JS), so a
  Metro reload is enough on the Pixel 7; no EAS build.
- **Outbox compatibility (the one state risk).** The mobile outbox
  (`zero-app-outbox.sqlite`) and the web IndexedDB outbox persist pending
  transactions by `mutationFnName`. A queued offline write from the old build
  that replays on the new build must still find its mutationFn. Keep the
  mutationFn names **exactly** `addCapture`, `processCapture`, `editCapture`,
  `rescheduleCapture`, `reorderCapture`, `addTask`, `completeTask`,
  `addProject`, `setProjectStatus`, `editProject`: the spec carries a
  `mutationFnName` per verb (or the verb keys are those names). Also keep the
  persisted collection ids `captures` / `tasks` / `projects` and the outbox
  `collections` keys the same, else the local cache is orphaned (harmless but a
  re-sync) and — worse — a replayed transaction cannot find its collection.
- Screens keep their `useLiveQuery` reads and `tx.isPersisted.promise` error
  handling untouched.

## Implementation phases

Each phase leaves the tree green; commit per phase.

1. **`collection/base.ts` + `reconcileWrites` + `view.ts`, tested at the base's
   interface.** Write `base.test.ts` by porting the Capture collection test
   (the richest: add no-flicker, edit/reschedule/reorder routing, process
   no-flicker) against a small synthetic spec, plus `leavesCollection` removal
   and `reconcileWrites` cases. Nothing consumes it yet.
2. **Migrate Projects** (smallest, newest, has all three verb shapes: insert,
   update-with-removal, partial edit). Rewrite `projects/collection.ts` over the
   base; `projects/collection.test.ts` runs unchanged against the same exported
   names. Delete `projectsReconcileWrites` tests (covered in phase 1).
3. **Migrate Tasks, then Captures.** Same shape. Captures brings the four-way
   update routing; its existing routing tests are the guard. Move
   `StartOfflineExecutor` / `WarnFn` to the base.
4. **`listView`** across agent-core + the four screens; delete the three view
   files and tests.
5. **Mobile wiring** (`defineMobileEntityApi`), then **web wiring**. Run the
   mobile jest suite and web typecheck/lint.
6. **Docs**: see below. Update the stale "extract at #3" comments in the three
   server stores and `tasks/view.ts`-style comments that no longer exist.

## Test strategy

- **Base** (in-process, pure + in-memory collection): the ported no-flicker and
  routing tests at `createInMemoryEntityApi`'s interface; `reconcileWrites`
  cases (insert-all, update-present, delete-missing, clear, no-duplicate insert).
  This replaces the three per-entity `*ReconcileWrites` suites (replace, don't
  layer).
- **Per-entity** collection tests stay as-is: they are the guard that the
  entity's verb table reproduces today's behavior (Capture routing, Project
  done-removal, Task complete). They now test through the same names but a
  different implementation, which is exactly the point.
- **Persisted path** has no unit test today (needs SQLite persistence + outbox);
  keep it that way, and verify on the Pixel 7 dev client: create a project and a
  capture offline (airplane mode), go online, confirm one row each and no
  duplicate; then reorder a capture and change a project status online.
- **Surfaces**: mobile jest (`jest --runInBand`), web + mobile `typecheck` and
  `lint`, agent-api tests unchanged (only comments move there).
- This box cannot run `workerd`, so no full local worker; the package-level
  checks above plus the on-device pass are the proof.

## Documentation strategy

- `docs/storage.md` (client layer): one sentence that every entity collection is
  built from the shared factory in `@zero/agent-core` (`collection/base.ts`)
  with a per-entity verb table; drop the "sibling" wording if any.
- `docs/todo-app.md`: Rule-of-Three status paragraph → extracted (date), what
  was extracted, what stayed per-entity and why; move the "Next" bullet off the
  list.
- `docs/entities/project.md`, `task.md`, `capture.md`: the "Storage" / "Data
  layer" bullets stop saying "sibling / duplication deliberate / extraction due"
  and point at `docs/storage.md`. Remove the duplicated "Rule-of-Three
  extraction" bullet under Project's "Next" (it appears twice today).
- `docs/plans/todo-project-entity.md`: mark the follow-up as shipped with a
  pointer here.
- Code comments in the three entity collection files: state what the file holds
  now (verbs + spec), not the history.
- No changelog entry (internal).

## Skills to use

- `vocabulary` / `deep-modules` — the base is one deep module; `EntitySpec` is
  its interface; per-entity files are the only callers. Do not expose internal
  seams (controls, reconcile) through it.
- `tdd` — phase 1: write `base.test.ts` first from the ported Capture tests.
- `testing` — deciding what stays mocked (REST fakes) vs real (in-memory
  collection).
- `git-commit` — one commit per phase.
- `reproducible-locally` — package checks + Pixel 7 offline replay pass, since
  `workerd` cannot run here.

## Acceptance criteria

- `packages/agent-core/src/collection/base.ts` exists; `captures/`, `tasks/`,
  `projects/` `collection.ts` each contain no `createCollection`,
  `persistedCollectionOptions`, `queryCollectionOptions`, or
  `startOfflineExecutor` call (grep returns only `collection/base.ts`).
- One `listView`; no `capturesView` / `todayView` / `projectsView` symbol
  remains anywhere in the repo.
- `apps/agent-mobile/src/lib/*-collection.ts` contain no
  `@tanstack/offline-transactions/react-native` import (only `entity-api.ts`
  does); the two hooks delegate to the shared helper.
- Every exported name the apps and tests import today still exists with the
  same signature; screen files change only at the `listView` call.
- mutationFn names, persisted collection ids, and query keys are unchanged
  (assert with a base test that reads the spec's derived names).
- `pnpm --filter @zero/agent-core test|typecheck|lint`, `@zero/agent-web
  typecheck|lint`, `@zero/agent-mobile test|typecheck|lint`, `@zero/agent-api
  test` all green.
- On the Pixel 7 dev client: offline add of a capture and a project replays
  once each with no duplicate after reconnect.
- Docs listed above updated in the same change; no changelog entry.

## Risks and mitigations

- **Outbox replay after upgrade** finds no mutationFn / collection → stranded
  offline writes. Mitigation: names pinned (see System-wide impact) and asserted
  in a test.
- **TypeScript generics on the verb table** get heavy (`ArgsOf`, keyed
  actions). Mitigation: if inference fights back, type `actions` loosely inside
  the base and let each entity file's explicit `*Api` wrapper carry the precise
  signatures; the public surface stays exact either way.
- **Persisted path untested in CI** could regress silently. Mitigation: the
  base's persisted builder is a near-verbatim move of today's code; the on-device
  offline pass is mandatory before merge.
- **Project edit `changes`-vs-`modified` unification** alters what an offline
  edit sends. Mitigation: the server `PATCH` accepts partial fields already
  (`edit` writes only present keys), so partial is safe; noted as a deliberate
  change.
