# Project state cleanup and completion dependencies

> **Current delivery scope (2026-09-15):** implement and release Stage 1 only.
> Project dependency behavior remains planned and receives no code or changelog
> in this delivery.

## Bottom line

Build this in two stages on one branch.

1. **Pre-refactor commit:** replace the overloaded stored status with an honest
   three-state model, rename it end to end, and reset local offline state instead
   of carrying compatibility code.
2. **Feature commits:** add explicit dependencies between existing projects and a
   calculated **Blocked** status. Blocked sits after Waiting and before Backlog.
   Removing the final blocker recalculates the project normally: Active for
   arrived scheduled work, Waiting for another remaining reason, and Next
   otherwise.

Project creation remains unchanged and creates no automatic dependency.

## End-state model

### Persisted state

```ts
type ProjectState = "in-play" | "backlog" | "done";

type Project = {
  // existing fields
  state: ProjectState;
};
```

- `in-play` means the app calculates where the project belongs.
- `backlog` and `done` are deliberate user decisions.

### Calculated status

Before dependencies:

```ts
type ProjectDisplayStatus =
  | "active"
  | "next"
  | "waiting"
  | "backlog"
  | "done";
```

After dependencies:

```ts
type ProjectDisplayStatus =
  | "active"
  | "next"
  | "waiting"
  | "blocked"
  | "backlog"
  | "done";
```

Final derivation order:

1. persisted Backlog or Done;
2. unresolved project-completion dependency → Blocked;
3. arrived scheduled open task → Active;
4. another unresolved condition → Waiting;
5. future scheduled task → Waiting;
6. Next.

### Dependency representation

For existing projects **Move house** and **Sell old house**:

1. Open **Move house**.
2. Tap its status pill.
3. Tap **Depends on project…**.
4. Pick **Sell old house**.
5. See:

   ```text
   Blocked · after 🏠 Sell old house

   Depends on

   🏠  Sell old house                         ›
       Must be completed first
   ```

6. Tap the row to open the prerequisite, or use its separate remove action.
7. Find **Move house** in a Blocked section after Waiting and before Backlog.
8. Complete **Sell old house**. **Move house** becomes Active, Waiting, or Next
   from its remaining work.

Several prerequisites are allowed. Compact context reads
`after <icon> <title>` for one and `after N projects` for several.

## Why the refactor comes first

The current `ProjectStatus` means two different things:

- the database and write interface accept Active, Next, Waiting, Backlog, Done;
- the UI calculates Active, Next, and Waiting and only meaningfully persists
  “put in play,” Backlog, and Done.

Adding Blocked to that type would let a calculated relationship state leak into
storage, routes, and collection writes. The pre-refactor gives persistence and
presentation separate interfaces before the feature adds another calculated
state.

## Why Blocked is separate

- **Waiting** — an in-play project is waiting on a person, event, ordinary
  condition, or scheduled date.
- **Blocked** — an in-play project cannot proceed until another project is Done.
- **Backlog** — the user deliberately parked the project.

Putting dependencies in Waiting mixes deterministic project sequencing with
open-ended waits and clutters Waiting on. Putting them in Backlog overloads a
manual “someday” state with an automatically reversible relationship.

The final section order is:

```text
Active
Next
Waiting
Blocked
Backlog
```

## Current state and constraints

- The checkout is current with `origin/main` at `e3fbb5877` on 2026-09-15. The
  only untracked file is this plan.
- `projects.status` and `ProjectStatus` currently allow
  `active | next | waiting | backlog | done`.
- The UI writes only Next (“Put in play”), Backlog, and Done. Active, Next, and
  Waiting are calculated by `projectDisplayStatus`; stored Active/Waiting rows
  are already treated as in play.
- New projects store Next. Historical rows can contain Active or Waiting.
- Mobile and web persist entity snapshots locally, and mobile has a separate
  durable outbox. The user has approved a full local refresh, including dropping
  queued offline writes, so this plan adds no legacy row, route, or mutation
  compatibility.
- `waiting_conditions` already stores a project completion relation as dependent
  `projectId`, prerequisite `refId`, `kind: "project-status"`, and
  `targetStatus: "done"`.
- Done projects leave the working Projects collection, so terminal dependency
  settlement must persist before the prerequisite disappears.
- The mobile app uses Expo SDK 57 and `@expo/ui` 57. The feature reuses the
  existing status sheet and project picker and needs no native dependency or new
  development-client build.

## Stage 1 — Pre-refactor commit

### Goal

Land one behavior-preserving commit before dependency work:

```text
refactor(todo): separate project state from display status
```

The commit removes `ProjectStatus` rather than preserving it as a legacy type.
Every active module uses either `ProjectState` or `ProjectDisplayStatus`.

### 1. Rename the persisted model end to end

In shared code:

- replace `ProjectStatus` with `ProjectState` and `ProjectDisplayStatus`;
- rename `Project.status` to `Project.state`;
- rename `ProjectsApi.setStatus` to `setState`;
- rename the project collection verb and durable mutation key from
  `setProjectStatus` to `setProjectState`;
- create projects optimistically with `state: "in-play"`;
- keep Done as the only state that leaves the working collection.

In the server:

- rename the `projects.status` SQLite column to `state`;
- normalize Active, Next, and Waiting rows to `in-play`;
- rename store, `UserDO`, and route vocabulary to state;
- change project request/response JSON from `status` to `state`;
- accept only `in-play | backlog | done` at persistence routes;
- default new projects to In-play.

In callers:

- **Put in play** writes `in-play`;
- Backlog and Done write their matching state;
- list grouping, status labels, and project headers use
  `ProjectDisplayStatus`;
- `projectDisplayStatus` reads `project.state`, returns stored Backlog/Done, and
  calculates Active/Next/Waiting for In-play.

Rename `STATUS_LABELS` to a display-specific name and remove `ALL_STATUSES` or
replace it with a value whose type cannot be passed to `setState`.

### 2. Migrate authoritative server data

Add `0053_project_state.sql` and register it.

The migration rebuilds or renames the Project column while mapping:

```text
active  → in-play
next    → in-play
waiting → in-play
backlog → backlog
done    → done
```

Preserve every other field and rebuild the open-project partial index against
`state != 'done'`.

No legacy value remains in authoritative SQLite after migration.

### 3. Add one central cache-version mechanism

There is currently a per-entity `EntitySpec.schemaVersion`, defaulted to the
literal `1` in `collection/base.ts`. The persistence adapter already resets a
collection automatically when that integer changes, but there is no single
version that invalidates every synchronized entity cache.

Add `packages/agent-core/src/collection/version.ts` as the one control point:

```ts
export const ENTITY_CACHE_VERSION = 2;
export const OFFLINE_OUTBOX_VERSION = 2;
```

Use `ENTITY_CACHE_VERSION` for every persisted entity collection in
`collection/base.ts` and remove the per-entity `schemaVersion` option. A single
future bump then clears Capture/Task/Project/WaitingCondition synchronized
snapshots on mobile and web. Each collection refills through its normal server
fetch. This is the reusable, non-destructive cache-invalidation mechanism.

The outbox is not a cache: it contains unsent writes. Keep its epoch separate so
a routine cache refresh cannot silently discard user work. Use
`OFFLINE_OUTBOX_VERSION` in:

- the mobile outbox SQLite filename;
- a versioned web IndexedDB outbox adapter supplied to each executor.

Commit 1 changes both constants because its renamed Project row and mutation verb
make old queued writes unreadable, and dropping those writes is explicitly
accepted. A future cache-only reset changes only `ENTITY_CACHE_VERSION`.

Do not write hydration adapters or retain old outbox mutation names. Treat the
server as authoritative after the reset. Old local tables/outbox databases may
remain unreachable until normal platform storage cleanup; new code never opens
or replays them.

This mechanism covers server-backed entity snapshots and the mutation outbox. It
deliberately does not clear Clerk credentials, timezone preferences, or the
separately versioned icon-suggestion hint cache.

### 4. Keep visible behavior unchanged

Update all shared, server, web, and mobile fixtures and callers in the same
commit. The screens still show Active, Next, Waiting, Backlog, and Done exactly
as before. Only the internal persisted concept changes.

Update `docs/entities/project.md` and `docs/todo-app.md` with the state/status
split. Add no product changelog because the intended product behavior is
unchanged; record the one-time local refresh in the technical documentation.

### 5. Verify Commit 1 independently

Tests must prove:

- `ProjectState` has exactly In-play, Backlog, Done;
- `ProjectDisplayStatus` has exactly Active, Next, Waiting, Backlog, Done;
- display values cannot reach `setState`;
- migration `0053` preserves rows and maps every old value correctly;
- new projects persist In-play;
- project REST JSON uses `state` and rejects the old `status` field;
- collection writes use `setProjectState` and the new Project shape;
- every persisted entity collection receives `ENTITY_CACHE_VERSION`;
- one cache-version bump resets all synchronized entity snapshots;
- mobile and web outboxes are namespaced by `OFFLINE_OUTBOX_VERSION`;
- a cache-only bump does not clear queued writes;
- existing display derivation produces the same visible result for equivalent
  In-play fixtures;
- all current Projects, Home, and project-detail screen behavior remains green.

Pixel 7 verification occurs with the new Worker and new Metro bundle together:

1. Launch online so the refreshed local collections refill from the server.
2. Inspect project grouping and one project detail read-only.
3. Create a throwaway project.
4. Move it to Backlog, put it back in play, and delete it.
5. Relaunch offline after the online refill and confirm the new Project snapshot
   loads locally.

The dependency feature starts only after this commit is green and device-verified.

## Stage 2 — Explicit project dependencies

### 1. Add Blocked only to display status

Extend `ProjectDisplayStatus` with `blocked`. Do not add it to `ProjectState`,
SQLite, project write routes, or collection persistence verbs.

Apply the final derivation and section order defined above. A stored Backlog or
Done still wins. Removing the final dependency reruns normal derivation; it does
not write In-play or force Next.

### 2. Add one dependency module

Keep WaitingCondition as the stored entity. Add:

```ts
waitsApi.dependOnProject(dependentProjectId, prerequisiteProjectId)
```

It owns the existing internal shape:

```ts
{
  kind: "project-status",
  projectId: dependentProjectId,
  refId: prerequisiteProjectId,
  targetStatus: "done"
}
```

A focused pure module in `@zero/agent-core` owns:

- completion-dependency identification;
- unresolved dependencies for one project;
- candidate filtering;
- direct and transitive cycle detection;
- one/many/missing-target context;
- oldest-dependency sort key.

The graph is acyclic. Exclude self, duplicate prerequisites, Done projects, and
candidates that can already reach the dependent.

### 3. Represent Blocked separately

Add shared status context:

- Waiting condition: `for <elapsed>`;
- future date: `until <day>`;
- one dependency: `after <icon> <title>`;
- several dependencies: `after N projects`.

Split project detail into:

- **Waiting on** for free-text, task, and historical non-completion conditions;
- **Depends on** for project-completion prerequisites.

A dependency row shows the prerequisite icon/title, **Must be completed first**,
navigation, and a separate remove action. Do not show `auto`. Hide empty
sections.

### 4. Add explicit linking

Mobile:

1. Add **Depends on project…** to the status sheet.
2. Close the native status sheet before opening the plain React Native picker.
3. Deepen the picker with configurable title, optional No-project row, supplied
   candidates, and **No available projects**.
4. Call `dependOnProject` and keep the dependent screen open.
5. Navigate through dependency rows.

Web:

- rename the existing structured choice to **Project completion**;
- remove its generic target-status picker;
- use the same dependency verb and candidate rules;
- render Depends on separately.

Keep free-text Waiting and every project-creation flow unchanged.

### 5. Enforce and settle on the server

Add store behavior for:

- prerequisite lookup;
- missing-side, self, duplicate, and cycle validation;
- idempotent `resolveForCompletedProject(projectId)`;
- `deleteByReferencedProject(projectId)`;
- stable first `resolvedAt`.

Compose in `UserDO`:

- dependency add requires two existing projects and an unfinished prerequisite;
- project Done resolves incoming dependencies before returning;
- project deletion removes incoming dependencies in addition to the current
  task/owned-condition cascade.

Keep the existing waiting-condition route and row shape. Map graph conflicts to
`409`. Log ids and counts only.

After a Done project-state transaction persists, mobile and web refetch waits.
The optimistic Done state gives immediate feedback; persisted `resolvedAt` keeps
the relation settled after the prerequisite leaves the working collection.

Add `0054_resolve_completed_project_dependencies.sql` for historical open
completion dependencies whose prerequisite is already Done.

### 6. Wire Blocked into Home

`homeCallToAction` counts Blocked separately.

- Mixed Next/Waiting/Blocked states include the Blocked count.
- An all-Blocked set shows **Everything is blocked** and
  **Review dependencies**.
- It never falls through to Create-first-project or Bring-forward copy.

## Commit sequence

### Commit 1

```text
refactor(todo): separate project state from display status
```

Includes the clean rename, migration `0053`, central cache/outbox version
controls, a full synchronized-cache reset, a full outbox epoch reset, callers,
tests, and technical docs. It has no compatibility layer and must be green
before feature code starts.

### Commit 2

```text
feat(todo): add project completion dependency model
```

Includes the dependency verb/graph, server validation and settlement, deletion
cleanup, migration `0054`, and domain/store/route tests.

### Commit 3

```text
feat(todo): show project dependencies as blocked
```

Includes Blocked derivation/section/context, mobile/web linking, Depends-on
presentation, Home handling, surface tests, changelogs, docs, and Pixel evidence.

Commits 2 and 3 ship together.

## Alternatives considered

- **Compatibility adapters:** rejected by explicit decision. Local state and
  queued offline writes may be discarded and fetched again.
- **Keep the serialized `status` name:** rejected. With reset accepted, rename
  the concept fully to `state` instead of preserving ambiguity.
- **Add Blocked to persisted state:** rejected. It is derived from relationship
  rows and would duplicate state.
- **Use Waiting:** rejected because it mixes project sequencing with people,
  events, conditions, and dates.
- **Use Backlog:** rejected because Backlog is a manual parking decision.
- **Force Next after unblocking:** rejected because arrived scheduled work makes
  the project Active.
- **Link during project creation:** out of scope. Dependencies are explicit links
  between existing projects.

## System-wide impact

- Commit 1 is a breaking internal data-shape change across server, web, mobile,
  local snapshots, and outbox storage.
- Authoritative server data is migrated without loss.
- `ENTITY_CACHE_VERSION` resets all synchronized entity snapshots once; the
  server refills them.
- `OFFLINE_OUTBOX_VERSION` separately discards queued writes once for this
  breaking refactor.
- Old mobile bundles stop syncing after the new Worker deploys; the new client
  bundle must be used with the new server. This is accepted by the no-compatibility
  decision.
- Commit 2 adds Blocked presentation and dependency settlement without changing
  Project persistence again.
- Pushes affecting API/web redeploy `zero-api`; space deployments to avoid
  repeated Durable Object resets.

## Out of scope

- Any legacy status/state, REST, local-row, or outbox compatibility.
- Preserving queued offline writes across Commit 1.
- Automatic creation-time dependencies.
- Creating prerequisites from the picker.
- Parent/child ownership, nested project trees, inherited tasks, or cascade
  completion.
- Full graph visualization or transitive explanatory copy.
- Manual dependency ordering.
- Persisting reversible task-done or non-terminal project-status satisfaction.
- New native packages or collection-factory verb kinds.

## Test strategy

### Refactor tests

- SQL migration maps every old value and preserves every Project field.
- Store and route contracts use only `state`.
- Old `status` requests fail validation.
- Shared/client Project rows contain `state`, never `status`.
- Collection mutation is `setProjectState`.
- Every entity cache uses the central `ENTITY_CACHE_VERSION` and resets on its
  bump.
- Mobile/web outboxes use the central `OFFLINE_OUTBOX_VERSION`, and changing only
  the cache version leaves them intact.
- Active/Next/Waiting display derivation remains behaviorally identical.
- Existing screen suites retain their visible behavior.
- Typecheck prevents passing display values into persistence.

### Dependency tests

- Recognition excludes non-completion conditions.
- Graph validation rejects self, duplicate, direct cycle, and transitive cycle.
- Creation writes the existing condition shape exactly once.
- Completion resolves matching incoming dependencies only and is idempotent.
- Delete removes incoming and owned relations without touching unrelated rows.
- Migration `0054` repairs only dependencies whose prerequisite is Done.

### Display/surface tests

- Blocked outranks Active and Waiting for In-play projects.
- Backlog and Done outrank Blocked.
- Unblocking derives Active, Waiting, or Next correctly.
- Section order is Active, Next, Waiting, Blocked, Backlog.
- One/many/missing-target context is correct.
- Home task visibility and empty state handle Blocked.
- Mobile status sheet, picker filtering, link, navigation, and removal work.
- Web Project completion and Depends-on presentation match.
- Creation remains independent.

## Documentation and changelogs

Commit 1 updates `docs/entities/project.md` and `docs/todo-app.md` with the
state/display split, the central cache/outbox versions, and the one-time offline
refresh. It adds no product changelog because project behavior is unchanged.

The feature commit loads the `changelog` skill and updates:

- `apps/agent-mobile/CHANGELOG.md`;
- `apps/agent-web/CHANGELOG.md`;
- `docs/entities/project.md`;
- `docs/entities/waiting-condition.md`;
- `docs/todo-app.md`.

Do not add an Agent changelog entry.

## Verification

Run affected package checks because this NixOS host cannot start `workerd`:

1. `gob run pnpm --filter @zero/agent-core test`
2. `gob run pnpm --filter @zero/agent-core lint`
3. `gob run pnpm --filter @zero/agent-core typecheck`
4. `gob run pnpm --filter @zero/agent-api test`
5. `gob run pnpm --filter @zero/agent-api lint`
6. `gob run pnpm --filter @zero/agent-api typecheck`
7. `gob run pnpm --filter @zero/agent-web test`
8. `gob run pnpm --filter @zero/agent-web lint`
9. `gob run pnpm --filter @zero/agent-web typecheck`
10. `gob run pnpm --filter @zero/agent-mobile test`
11. `gob run pnpm --filter @zero/agent-mobile lint`
12. `gob run pnpm --filter @zero/agent-mobile typecheck`
13. `gob run pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-project-dependency`

GitHub Actions supplies whole-repo checks and the deploy dry-run.

### Pixel 7 — Commit 1

Use the new Worker and new Metro bundle together:

1. Launch online and let every collection refill.
2. Inspect project grouping and one detail screen read-only.
3. Create a throwaway project.
4. Move it to Backlog, put it in play, and delete it.
5. Relaunch offline and confirm the refreshed Project snapshot loads.

### Pixel 7 — Feature

1. Create throwaway dependent and prerequisite projects.
2. Link them through **Depends on project…**.
3. Capture the Blocked header and Depends-on row.
4. Navigate through the prerequisite row.
5. Verify Blocked appears after Waiting and before Backlog.
6. Remove the relation and verify Next.
7. Add an arrived scheduled task, restore/remove the relation, and verify Active.
8. Delete the task and both projects. Leave no throwaway production data.

Automated tests prove Done settlement without leaving a hidden completed project
in production. No EAS rebuild is required.

## Skills to use

- `tdd` — land the refactor and feature through red-green-refactor.
- `testing` — test through state, derivation, store, collection, and screen
  interfaces.
- `deep-modules` and `vocabulary` — keep persisted state and calculated status
  separate and localize dependency behavior.
- `expo-overview`, `expo-ui`, and `expo-data-fetching` — preserve SDK 57 native
  controls and verify the deliberate offline refresh.
- `impeccable` — verify Blocked and Depends on remain compact and direct.
- `changelog` and `documentation` — update the technical model with Commit 1 and
  user-visible behavior with the feature.
- `reproducible-locally` — retain package and Pixel evidence.
- `git-commit` — keep Commit 1 independently green and commit feature behavior
  with tests and release notes.

## Acceptance criteria

### Commit 1

- Project persistence uses `state: in-play | backlog | done` end to end.
- Calculated status has a separate type.
- No `ProjectStatus`, Project `status` field, `setProjectStatus`, or legacy status
  route remains.
- Authoritative server rows migrate without loss.
- One `ENTITY_CACHE_VERSION` bump resets every synchronized entity snapshot;
  one separate `OFFLINE_OUTBOX_VERSION` bump discards queued writes for this
  refactor.
- Existing Active/Next/Waiting/Backlog/Done presentation remains unchanged.
- Package checks, Android export, online refill, and offline relaunch pass before
  dependency work starts.

### Dependency feature

- Users explicitly link existing projects; creation remains independent.
- Self, duplicate, missing-target, and cyclic links are rejected.
- Blocked exists only as calculated status.
- Section order is Active, Next, Waiting, Blocked, Backlog.
- Dependencies appear under Depends on as navigable project rows, not under
  Waiting on.
- Blocked projects hide Home tasks.
- Unblocking derives Active for arrived work, Waiting for another reason, and
  Next otherwise.
- Completion settles incoming dependencies before the prerequisite leaves the
  working set; deletion removes incoming links.
- Home empty-state copy handles Blocked.
- Agent-core, agent-api, web, and mobile checks pass; Android export and both
  Pixel gates pass; all throwaway production data is deleted.
- Feature changelogs and entity/todo documentation ship with the feature.
