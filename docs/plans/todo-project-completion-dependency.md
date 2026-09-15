# Project completion dependencies

## Bottom line

Let a user explicitly make one existing project depend on completion of another
existing project. The dependent project gets a calculated **Blocked** status,
appears in a separate Blocked section after Waiting and before Backlog, and lists
its prerequisites under a separate **Depends on** section.

Completing the final prerequisite removes the dependency and recalculates the
dependent project normally:

- Active when arrived scheduled work exists;
- Waiting when another ordinary condition or future date remains;
- Next otherwise.

Project creation remains independent and unchanged. Blocking never changes task
dates: all dependent tasks stay off Home while blocked, and arrived tasks return
immediately when the final dependency settles or is removed.

Use the existing waiting-condition storage shape:

```ts
{
  kind: "project-status",
  projectId: dependentProjectId,
  refId: prerequisiteProjectId,
  targetStatus: "done"
}
```

Do not add a parent-project column or persist Blocked on Project. The dependency
row is the source of truth; Blocked is calculated from unresolved dependency
rows.

## Prerequisite already complete

Commit `929ede6d9` separated persisted Project state from calculated display
status and shipped on 2026-09-15:

```ts
type ProjectState = "in-play" | "backlog" | "done";

type ProjectDisplayStatus =
  | "active"
  | "next"
  | "waiting"
  | "backlog"
  | "done";
```

Project persistence now uses `Project.state`; `projectDisplayStatus` owns
presentation. This feature extends only `ProjectDisplayStatus` with `blocked`.
No further Project schema migration is needed.

## User flow

For existing projects **Move house** and **Sell old house**:

1. Open **Move house**.
2. Tap its status pill.
3. Tap **Depends on project…**.
4. Pick **Sell old house**.
5. Stay on **Move house** and see:

   ```text
   Blocked · after 🏠 Sell old house

   Depends on

   🏠  Sell old house                         ›
       Must be completed first
   ```

6. Tap the dependency row to open **Sell old house**.
7. Use the row's separate remove action to remove only that relationship.
8. In Projects, find **Move house** under Blocked after Waiting and before
   Backlog.
9. Complete **Sell old house**. **Move house** automatically becomes Active,
   Waiting, or Next from its remaining state.

A project can have several prerequisites. Compact context reads
`after <icon> <title>` for one prerequisite and `after N projects` for several.

A Backlog project may retain dependency rows, but its deliberate Backlog state
wins. After **Move out of backlog**, it displays Blocked while any prerequisite
remains.

Deleting a prerequisite remains allowed. Its confirmation names one affected
project or reports the affected count, and distinguishes projects that will be
unblocked from projects that retain other prerequisites. Confirming removes the
incoming relationships and recalculates every dependent.

## Why Blocked is separate

- **Waiting** means an in-play project is waiting on a person, event, ordinary
  condition, or scheduled date.
- **Blocked** means an in-play project cannot proceed until another project is
  Done.
- **Backlog** means the user deliberately parked the project.

Putting dependencies in Waiting mixes deterministic project sequencing with
open-ended waits and clutters Waiting on. Putting them in Backlog overloads a
manual “someday” state with an automatically reversible relationship.

Final Projects order:

```text
Active
Next
Waiting
Blocked
Backlog
```

## Current state and constraints

- `ProjectDisplayStatus` is separate from `ProjectState`, so Blocked can remain
  presentation-only.
- `waiting_conditions` already stores dependent `projectId`, referenced `refId`,
  `project-status` kind, and a target display status.
- `WaitsApi.add` can already create the required row, but callers must currently
  know its internal kind/target fields.
- Mobile renders structured waiting conditions but can create only free-text
  conditions. Web exposes a generic “project reaches status” builder.
- Both detail screens currently place all waiting-condition kinds under Waiting
  on and label structured rows `auto`.
- Mobile's status pill already opens the lifecycle-action sheet.
- Mobile's `ProjectPickerSheet` already supports search, bounded scrolling,
  keyboard docking, a configurable title, and selected-row state. It always
  includes No project and has no unfiltered empty state.
- Done projects leave the working Projects collection. A client-only comparison
  can see optimistic Done but cannot keep a condition satisfied after the target
  row disappears.
- Project deletion removes conditions owned by the deleted project, but not
  incoming project-status conditions that reference it.
- `homeCallToAction` does not know Blocked and would misclassify an all-Blocked
  working set.
- The mobile app is Expo SDK 57. This feature adds no native dependency or
  configuration.

## Technical design

### 1. Extend only calculated display status

Add `blocked` to `ProjectDisplayStatus`. Keep `ProjectState`, Project REST
schemas, and Project collection writes unchanged.

Change `projectDisplayStatus` precedence to:

1. persisted Backlog or Done;
2. unresolved project-completion dependency → Blocked;
3. arrived scheduled open task → Active;
4. another unresolved condition → Waiting;
5. future scheduled task → Waiting;
6. Next.

A completion dependency is a hard blocker. An arrived task cannot make the
project Active until the dependency settles. Ordinary conditions retain their
current softer behavior: arrived scheduled work can still override them.

When the final dependency disappears, do not write Project state or alter task
dates. Run the same derivation again; any arrived dated tasks return to Home
immediately.

### 2. Add one deep dependency module

Create a focused pure module under `packages/agent-core/src/projects/` that owns
all project-dependency interpretation:

- `isProjectCompletionDependency(condition)`;
- unresolved dependency rows for one dependent project;
- referenced prerequisite lookup;
- candidate filtering;
- direct and transitive cycle detection;
- one/many/missing-target context;
- oldest dependency timestamp for Blocked ordering;
- incoming dependents and accurate prerequisite-removal impact copy.

Its inputs are plain Project and WaitingCondition arrays. All dependencies are
in-process, so tests call this interface directly; no adapter is needed.

Add a narrow convenience verb to `WaitsApi`:

```ts
dependOnProject(dependentProjectId, prerequisiteProjectId): Transaction
```

It delegates to the existing `addWaitingCondition` collection action with
`kind: "project-status"`, `targetStatus: "done"`, and null text. Keep the durable
outbox mutation name `addWaitingCondition`; the local row shape and persistence
contract do not change.

Screens use `dependOnProject` and never construct the storage fields.

### 3. Keep the dependency graph acyclic

The proposed edge direction is:

```text
dependent → prerequisite
```

Adding A → B is invalid when B can already reach A through completion-dependency
edges.

Client candidate filtering excludes:

- the dependent project itself;
- an existing direct prerequisite;
- Done projects, already absent from the working collection;
- any candidate that creates a direct or transitive cycle.

The server repeats these checks because a client can be stale. Server validation
also rejects a missing dependent, missing prerequisite, or prerequisite that is
already Done.

Use `409 Conflict` for a well-formed relationship that cannot be added. Keep
`400` for malformed ids/kinds/fields and `404` for ordinary missing-resource
routes.

### 4. Calculate Blocked presentation in one shared module

Keep `waitingBadge` focused on Waiting. Add a higher-level status-context helper
that returns the compact label and within-section sort key:

- condition wait: `for <elapsed>`;
- date wait: `until <day>`;
- one project dependency: `after <icon> <title>`;
- several dependencies: `after N projects`;
- missing target during recovery: `after another project`.

Both Projects screens and both project headers consume this interface. Do not
repeat grammar or ordering branches per surface.

Within Blocked, sort by the oldest unresolved dependency first. The separate
section supplies the cross-status placement, so Waiting's existing
condition-before-date order remains unchanged.

Compact context stays on one line and truncates before it competes with the
dependent project's own title.

### 5. Represent dependencies separately from Waiting on

Split each project's open conditions into:

- project-completion dependencies;
- every other waiting condition.

Render dependencies under **Depends on**. One row contains:

- prerequisite emoji;
- prerequisite title;
- secondary text **Must be completed first**;
- disclosure indicator;
- full-row navigation to `/projects/{prerequisiteId}`;
- a separate accessible remove action.

Do not display `auto`; it describes implementation rather than user intent.

Keep free-text, task-done, and historical non-completion project-status rows
under **Waiting on**. Hide either section when empty.

### 6. Add the explicit mobile linking action

Add **Depends on project…** to the existing mobile status sheet.

The screen owns the presentation sequence:

1. close the native `@expo/ui` status sheet;
2. open the plain React Native Project picker;
3. pass candidates from the shared dependency module;
4. call `waitsApi.dependOnProject(currentProject.id, selectedProject.id)`;
5. keep the current project screen open;
6. report persistence failures through the existing error channel.

Do not nest the React Native picker inside the native sheet.

Deepen `ProjectPickerSheet` only as required:

- make the No-project row optional;
- allow supplied empty-state copy when no candidates exist;
- retain its existing configurable title and search behavior.

Dependency configuration:

```text
title: Depends on
show No project: false
empty copy: No available projects
```

Keep the add drawer's free-text Waiting mode and every Project creation path
unchanged.

### 7. Tighten the web linking flow

In the existing Waiting-condition builder:

- rename the option to **Project completion**;
- remove the generic target-status picker from this path;
- show only the prerequisite picker;
- filter candidates through the shared dependency module;
- call `waitsApi.dependOnProject`.

Render Depends on separately using web-native controls. Do not share React
renderers with mobile; share only domain/presentation data.

### 8. Persist terminal settlement on the server

Add `DbProjectStore.get(id)` so the `UserDO` composition root can validate
working or Done projects.

Deepen `DbWaitingConditionStore` with:

- dependency edge listing/checking for server graph validation;
- `addProjectDependency(id, dependentId, prerequisiteId)`;
- `resolveForCompletedProject(projectId)`;
- `deleteByReferencedProject(projectId)`;
- idempotent single-condition resolution that preserves its first `resolvedAt`.

`addProjectDependency` inserts the existing waiting-condition shape. It does not
create a new table or entity type.

Compose in `UserDO`:

- validate both projects and the graph before dependency insert;
- after `setProjectState(id, "done")` succeeds, resolve every incoming completion
  dependency before returning;
- on hard delete, remove incoming dependency rows in addition to the existing
  tasks and owned-waits cascade; both clients show the locally known affected and
  unblocked project impact before confirmation.

In `routes/waits.ts`, recognize the completion-dependency shape and call the
validated dependency path. Return the same `{ condition }` response. Map domain
conflicts to 409 and log ids/counts only, never titles.

After a Done state transaction persists, mobile and web refetch waits. During
the optimistic transaction the prerequisite row still carries Done, providing
immediate local feedback. Persisted `resolvedAt` keeps the relationship settled
after the prerequisite leaves the working collection and across restarts or
other devices.

Add migration `0054_resolve_completed_project_dependencies.sql`. It changes no
schema. It sets `resolvedAt` on historical open project-status/Done conditions
whose referenced project is already stored as Done.

### 9. Wire Blocked into Home's empty state

Extend `HomeCallToAction` with Blocked counts.

- Mixed Next/Waiting/Blocked working sets include non-zero counts in the summary.
- An all-Blocked set shows **Everything is blocked** and a
  **Review dependencies** action to Projects.
- Blocked projects must not fall through to **Create your first project** or
  **Bring a project forward**.

`homeTasks` already gates project tasks through `projectDisplayStatus`; the hard
Blocked status hides those tasks without another rule.

## Implementation sequence

### Commit 1 — Dependency domain and durable settlement

```text
feat(todo): add project completion dependency model
```

Implement:

- shared dependency module and `dependOnProject` convenience verb;
- cycle/candidate rules;
- server validation;
- completion settlement and delete cleanup;
- migration 0054;
- pure, collection, store, route, and cross-store tests.

This commit may remain user-inaccessible until Commit 2. Keep both commits in the
same branch/PR or push them together so no partial product ships.

### Commit 2 — Blocked status and linking surfaces

```text
feat(todo): show project dependencies as blocked
```

Implement:

- Blocked derivation and section order;
- shared compact status context;
- mobile status action and picker configuration;
- mobile/web Depends-on sections and navigation/removal;
- simplified web Project completion builder;
- Home empty-state handling;
- screen tests;
- mobile/web changelogs and current documentation;
- Pixel 7 evidence.

## Alternatives considered

### Link projects during creation

Rejected for this increment. Creation timing does not define the relationship.
Explicit linking works for any two existing projects and keeps Project creation
predictable.

### Put dependencies in Waiting

Rejected. It mixes deterministic sequencing with people, events, ordinary
conditions, and dates, and clutters Waiting on.

### Put dependencies in Backlog

Rejected. Backlog is a deliberate parking decision and does not identify what
must finish.

### Persist Blocked as Project state

Rejected. Blocked follows from unresolved dependency rows. Persisting both would
duplicate state and permit disagreement.

### Add `dependsOnProjectId` to Project

Rejected. It duplicates waiting conditions and permits only one prerequisite.

### Force Next after unblocking

Rejected. Arrived scheduled work makes the project Active; another remaining
wait keeps it Waiting. Next is correct only when neither exists.

### Add a new dependency table

Rejected. The existing waiting-condition row already carries ownership,
reference, target status, timestamps, offline insertion, and removal behavior.

## System-wide impact

- **Project persistence:** unchanged; Blocked never crosses `ProjectState`.
- **WaitingCondition persistence:** same row shape; completion can now persist
  `resolvedAt` for terminal dependencies.
- **Projects:** new Blocked section on mobile and web.
- **Home:** blocked project tasks stay hidden; empty-state copy recognizes
  Blocked.
- **Project detail:** dependencies move to a navigable Depends-on section.
- **Offline:** dependency add/remove uses the existing durable waiting outbox.
  No entity cache or outbox version bump is needed because row and mutation
  shapes remain compatible.
- **Deletion:** deleting either side leaves no dangling dependency row.
- **Deployment:** API/web changes redeploy `zero-api`; mobile remains a separate
  preview release.

## Out of scope

- Automatic creation-time dependencies.
- Creating a prerequisite from the dependency picker.
- Parent/child ownership or nested project trees.
- Inherited tasks or cascade completion.
- A full dependency graph screen.
- Transitive copy such as “blocked through B on C”.
- Manual ordering of dependency rows.
- Persisting reversible task-done or non-terminal project-status satisfaction.
- Changing Backlog precedence.
- New native packages or collection-factory verb kinds.

## Test strategy

### Shared dependency tests

Test through the pure dependency interface:

- recognize only project-status/Done conditions;
- return one or several prerequisites for a dependent;
- exclude resolved rows;
- reject self and duplicate edges;
- detect direct and transitive cycles;
- accept an acyclic edge;
- summarize one, many, and missing targets;
- return the oldest dependency timestamp.

### Derivation and Home tests

- In-play plus dependency → Blocked.
- Blocked overrides an arrived task and ordinary Waiting.
- Backlog and Done override Blocked.
- Removing the final dependency leaves task dates unchanged, yields Active with
  arrived work, and returns that work to Home immediately.
- Removing it yields Waiting with another condition/date.
- Removing it yields Next otherwise.
- Section order is Active, Next, Waiting, Blocked, Backlog.
- `homeTasks` hides blocked-project tasks.
- mixed and all-Blocked Home calls to action are correct.

### Collection tests

- `dependOnProject` creates the exact existing condition shape.
- It uses `addWaitingCondition` as the durable mutation.
- Optimistic insertion changes calculated status immediately.
- Removal remains idempotent and offline-replayable.

### Server tests

Use the real do-orm SQLite stand-in:

- valid acyclic dependency persists exactly once;
- missing side, Done prerequisite, self, duplicate, direct cycle, and transitive
  cycle fail without a row;
- completing a prerequisite resolves only matching incoming dependencies;
- resolution preserves the first timestamp and replay changes zero rows;
- deleting a prerequisite removes incoming dependencies;
- deleting a dependent removes owned conditions through the existing cascade;
- unrelated conditions remain;
- migration 0054 repairs only open completion dependencies whose prerequisite is
  Done.

The `UserDO` has no non-workerd local harness. Follow the existing
cross-store composition-test pattern over one shared mock database.

### Mobile tests

- status sheet exposes **Depends on project…**;
- status sheet closes before the picker opens;
- picker excludes invalid/cyclic candidates;
- picker has no No-project row and shows **No available projects** when empty;
- selection writes dependent/prerequisite ids and keeps the screen open;
- header reads `Blocked · after …`;
- dependency appears under Depends on, not Waiting on;
- row navigation opens the prerequisite;
- remove deletes only that relation;
- Done refetches waits after persistence;
- prerequisite deletion reports affected/unblocked dependents before confirmation;
- creation and free-text Waiting remain unchanged.

### Web tests

- builder offers Project completion without a target-status picker;
- invalid candidates are absent;
- selection creates the dependency;
- Depends on is separate and navigable;
- Projects renders Blocked after Waiting and before Backlog;
- completion refetches and derives Active/Waiting/Next correctly;
- prerequisite deletion reports affected/unblocked dependents before confirmation.

## Documentation and changelogs

Load the `changelog` skill before editing.

Update in the user-visible commit:

- `apps/agent-mobile/CHANGELOG.md` — existing projects can depend on another;
  Blocked and Depends on make the relationship visible and completion clears it.
- `apps/agent-web/CHANGELOG.md` — same capability and durable unblocking.
- `docs/entities/project.md` — Blocked display status, section order, explicit
  linking, multiple prerequisites, navigation/removal, and post-unblock
  derivation.
- `docs/entities/waiting-condition.md` — completion-dependency subset, acyclic
  graph, persisted terminal settlement, and separate presentation.
- `docs/todo-app.md` — shipped result and Pixel evidence.

Do not add an Agent changelog entry. This belongs to the mobile and web todo
products.

## Verification

Stop Metro and local Gradle before checks. This NixOS host cannot start
`workerd`, so run affected packages directly:

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
13. `gob run pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-project-dependencies`

GitHub Actions supplies whole-repo checks and the deploy dry run.

### Pixel 7 proof

Use the development client, USB Metro, and Maestro. The client targets
production, so mutate only throwaway entities:

1. Create throwaway dependent and prerequisite projects.
2. Link them through **Depends on project…**.
3. Capture the Blocked header and Depends-on row.
4. Navigate through the prerequisite row and Back.
5. Verify Blocked appears after Waiting and before Backlog.
6. Remove the relation and verify Next.
7. Add an arrived scheduled task, restore the relation, and verify the task leaves
   Home while its date stays unchanged.
8. Delete the prerequisite, verify the confirmation names the dependent, and
   verify the dependent becomes Active with its dated task back on Home.
9. Delete the task and dependent; confirm no throwaway condition remains.

Automated server tests prove the Done path without leaving a hidden completed
throwaway project in production. No EAS rebuild is required.

## Skills to use

- `tdd` — implement each domain/server/surface slice through one failing behavior
  at a time.
- `testing` — test through module, store, collection, route, and screen
  interfaces.
- `deep-modules` and `vocabulary` — keep dependency interpretation in one deep
  module and Blocked out of persistence.
- `expo-overview`, `expo-ui`, and `expo-data-fetching` — preserve SDK 57 native
  presentation and offline writes/refetch.
- `impeccable` — verify Blocked and Depends on are compact, clear, and scannable.
- `changelog` and `documentation` — ship user-facing notes and current entity
  sources of truth with the feature.
- `reproducible-locally` — retain package, migration, Pixel, and screenshot
  evidence.
- `git-commit` — keep domain and user-visible commits independently green.

## Acceptance criteria

- A user can explicitly make one existing project depend on another existing
  project's completion.
- Creation flows remain independent.
- Self, duplicate, missing-target, Done-target, and cyclic relationships are
  rejected.
- One or several prerequisites can block the same project.
- Blocked exists only in `ProjectDisplayStatus`; Project persistence remains
  In-play/Backlog/Done.
- Project section order is Active, Next, Waiting, Blocked, Backlog on mobile and
  web.
- Dependency rows appear under Depends on as navigable project identities and do
  not clutter Waiting on.
- Compact status/list copy identifies one prerequisite or summarizes several.
- A blocked project's tasks stay off Home without changing their dates.
- Removing/completing the final prerequisite returns arrived work to Home
  immediately and derives Active, Waiting for another reason, or Next.
- Deleting a prerequisite warns about affected and newly unblocked dependents,
  then removes incoming relationships.
- Completion settles incoming dependencies before the prerequisite leaves the
  working set; deletion removes incoming relationships.
- Home empty-state copy handles mixed and all-Blocked project sets.
- No cache/outbox version bump or native dependency is introduced.
- Agent-core, agent-api, web, and mobile checks pass; Android export and Pixel 7
  verification pass; all throwaway production data is deleted.
- Mobile/web changelogs and current Project/WaitingCondition/todo documentation
  ship with the feature.
