# Project

A Project is a named, outcome-oriented container in the todo app. It groups work
toward an outcome and carries a small persisted lifecycle state; the app
calculates its visible status from that state, its tasks, and its waiting
conditions.

This file is the source of truth for Project behavior. Historical implementation
plans remain under `docs/plans/`.

## Why Project is its own entity

A Project answers “what outcome am I working toward,” which a Task does not. It
has its own title, icon, description, lifecycle, tasks, waiting conditions, and
delete cascade. Its server store remains specific to Project rather than joining
a generic entity repository.

## Vocabulary

- **Project** — the entity stored in `projects`.
- **Outcome name** — the required `title`, phrased as an observable result.
- **State** — the persisted lifecycle decision: `in-play`, `backlog`, or `done`.
- **Display status** — the calculated list/header value: Active, Next, Waiting,
  Backlog, or Done.
- **Put in play** — persist `state: "in-play"`, then calculate the current display
  status.
- **Icon** — one emoji, default 📁.

State and display status are intentionally separate. Active, Next, and Waiting
cannot cross a persistence interface.

## Data shape

`projects` lives in each user's `UserDO` SQLite database. Client-facing Project:

- `id` — client-minted UUID and exactly-once insert key;
- `title` — required outcome name;
- `icon` — one emoji, default 📁;
- `description` — nullable free text;
- `state` — `in-play | backlog | done`, default `in-play`;
- `createdAt` — ISO timestamp;
- `sourceCaptureId` — nullable provenance from the retired Capture/refine flow.

The `projects_open` partial index covers `state != 'done'` ordered by
`createdAt`, keeping completed projects out of the working-set index.

Migration `0053_project_state.sql` replaced the overloaded `status` column. It
mapped stored Active, Next, and Waiting values to In-play while preserving
Backlog, Done, and every other Project field.

## Calculated display status

`projectDisplayStatus` in `@zero/agent-core` is the single pure interface for
Project presentation. It uses the user's local `today` and applies this order:

1. persisted Backlog or Done;
2. Active when an open project task has a non-null `showUpDate <= today`;
3. Waiting when an unresolved waiting condition exists;
4. Waiting when an open project task has a future date;
5. Next otherwise.

An undated project task is groomed and does not make the project Active. A future
task makes the project wait until its day. An arrived scheduled task currently
overrides an ordinary waiting condition, so deliberate scheduled work can
continue; completing that task exposes the remaining wait again.

`waitingBadge` supplies Waiting context and ordering:

- an ordinary condition shows elapsed time and sorts longest-waiting first;
- a future task shows `until <day>` and sorts soonest first.

The Projects list groups through `projectsByStatus`; it never groups directly by
persisted state.

## Behavior

- **Add** — create by title with state In-play, icon 📁, and null description.
- **List** — return every non-Done project, oldest first; clients calculate and
  group display status.
- **Set state** — persist In-play, Backlog, or Done. Done removes the row from the
  working collection. In-play recalculates Active, Next, or Waiting.
- **Edit** — update any supplied title, icon, or description field.
- **Delete** — hard-remove the Project, all its tasks, and all waiting conditions
  owned by it. The `UserDO` composition root coordinates the three entity
  stores. Delete is idempotent and has no Undo.

All writes use the stable client id, so offline replay is exactly-once or
idempotent according to the verb.

## UI

Projects appear on web `/projects` and the mobile Projects tab. Both surfaces
show collapsible Active, Next, Waiting, and Backlog sections; Done is absent.
Backlog starts collapsed when large.

A project row opens a dedicated project screen. The screen contains:

- editable icon and title;
- calculated status pill;
- editable description;
- project tasks;
- real waiting conditions under **Waiting on**;
- lifecycle/delete actions.

Mobile uses the visible status pill as the lifecycle control. Its actions are
Move to backlog, Move out of backlog, and Mark done. The settings menu contains
Delete project. Web keeps lifecycle and delete actions in its overflow menu.

On mobile, project tasks reuse `ReorderableTaskList`: tap to edit, complete with
Undo, swipe right to schedule Tomorrow, and long-press to reorder. New project
tasks start undated. The Task/Waiting/Project add drawer presets Task to the open
project; Project mode creates an independent project.

A mobile Waiting status includes its context (`Waiting · until Tomorrow` or
`Waiting · for 5 days`). Future task dates are explained by the status and source
task, not duplicated under Waiting on. Web still shows its automatic date row.

## Storage and REST interfaces

`DbProjectStore` owns `add`, `list`, `setState`, `edit`, and `delete` over
the `projects` table. `UserDO.deleteProject` owns cross-entity deletion.

Per-user routes:

- `GET /api/projects` → `{ projects }`, non-Done working set;
- `POST /api/projects { id, title, icon?, description?, state? }` →
  `201 { project }`;
- `PATCH /api/projects/{id} { state?, title?, icon?, description? }` →
  `200 { project }`;
- `DELETE /api/projects/{id}` → `204`, including when already absent;
- `POST /api/projects/icon-suggestions { title, description? }` → `{ icons }`.

Project persistence accepts only `in-play`, `backlog`, and `done`. Unknown or
retired `status` fields are rejected.

The TanStack DB Project collection exposes `add`, `setState`, `edit`, `remove`,
and `refetch`. Its durable mutation names are `addProject`, `setProjectState`,
`editProject`, and `deleteProject`.

## Local data versions

`ENTITY_CACHE_VERSION` in `packages/agent-core/src/collection/version.ts` is the
single version for every server-backed entity snapshot. A bump resets all mobile
and web collection snapshots and refills them from the server.

`OFFLINE_OUTBOX_VERSION` is separate because the outbox contains unsent writes,
not cached data. Bump it only when a breaking mutation change intentionally
discards queued writes. Migration 0053's Project shape and verb rename bump both
versions once.

Clerk credentials, timezone preferences, and icon-suggestion hints are outside
these versions.

## Other entities

- Task membership uses nullable `Task.projectId`.
- WaitingCondition attaches to Project and can reference a Task or Project.
- Deleting a Project cascades to its Tasks and owned waiting conditions.
- Project icon suggestions are an ephemeral device-local hint, not Project data.

## Next

Explicit project-completion dependencies are designed in
`docs/plans/todo-project-completion-dependency.md`. They are not part of the
state refactor: creation and current Waiting behavior remain unchanged until
that feature is implemented.
