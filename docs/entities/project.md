# Project

A Project is a named, outcome-oriented container in the todo app. It groups work
toward an outcome, persists a small manual lifecycle state, and calculates the
attention state the user sees from Tasks, manual Waiting conditions, and After
relationships.

This file is the source of truth for Project behavior. Historical design and
implementation plans remain under `docs/plans/`.

## Vocabulary

- **State** — persisted lifecycle: `in-play`, `backlog`, or `done`.
- **Display status** — calculated presentation: Active, Next, Waiting, After,
  Backlog, or Done.
- **Waiting** — the Project still needs human review or follow-up because a
  manual text condition remains unresolved, or it has future-dated work.
- **After** — nothing needs attention until one or more referenced Projects are
  Done. It is sequencing, not necessarily a hard prerequisite.
- **Put in play** — persist `state: "in-play"`, then calculate display status.

Calculated statuses never cross the Project persistence interface.

## Data shape

`projects` lives in each user's `UserDO` SQLite database. Client-facing Project:

- `id` — client-minted UUID and exactly-once insert key;
- `title` — required outcome name;
- `icon` — one emoji, default 📁;
- `description` — nullable free text;
- `state` — `in-play | backlog | done`, default `in-play`;
- `createdAt` — ISO timestamp;
- `sourceCaptureId` — nullable dormant provenance.

## Calculated display status

Shared Project presentation applies this order:

1. persisted Backlog or Done;
2. Active when an open Project Task has a date at or before the local day;
3. Waiting when a manual condition is unresolved or an open Task has a future
   date;
4. After when an unresolved Project After relationship remains;
5. Next otherwise.

An empty In-play Project is Next. An undated Project Task is groomed and does not
make the Project Active.

After is a fallback attention state. Scheduling a Task deliberately brings the
Project forward without resolving its relationships. When that work completes,
the unresolved relationship can make the Project After again. Manual Waiting
also outranks After. Backlog and Done always outrank calculated attention.

`projectStatusContext` supplies Waiting and After copy and ordering. The detail
pill uses `After · 🏠 Buy a house`; a Projects row uses `after 🏠 Buy a house`.
Several relationships read `2 projects` / `after 2 projects`.

## Behavior

- **Add** — create by title with state In-play, icon 📁, and null description.
- **List** — return every non-Done Project, oldest first.
- **Set state** — persist In-play, Backlog, or Done.
- **Edit** — update supplied title, icon, or description fields.
- **Complete** — atomically persist Done and resolve every incoming After
  relationship before returning.
- **Undo completion** — revive the Project to its prior In-play or Backlog state
  and atomically restore the After relationships that completion resolved.
- **Delete** — atomically remove the Project, all its Tasks, manual Waiting
  conditions, outgoing After relationships, and incoming After relationships.
  Confirmation discloses which source Projects may move to another section.

All writes use stable ids so offline replay remains exactly-once or idempotent.

## Projects list

Both surfaces group Projects in this order:

1. Active;
2. Next;
3. Waiting;
4. After;
5. Backlog.

Empty sections are absent. Waiting stays expanded. After is collapsed by
default. Backlog retains its existing large-section collapse policy. A row shows
only its dominant status context; overridden After relationships remain visible
inside the Project workspace.

Project selectors on web and mobile use the same section order and within-section
ordering as this list. After starts collapsed; Backlog collapses when it has more
than five eligible Projects. Filtering reveals matches inside collapsed sections,
and clearing the filter restores the previous fold. Task assignment keeps a
separate No project choice; After selection shows only eligible targets while
calculating their status against the full Project and attention snapshot.

On mobile, the Projects-list Add control opens the shared global create drawer
with Project selected and Task also available. Project creation still opens the
new Project. Task creation stays on the list and can create a loose Task or use
the existing date and Project rows before submission.

## Project workspace

A Project opens its own screen. One scroll host may implement the screen, but the
visual hierarchy has sibling regions:

1. editable identity;
2. dominant status and lifecycle control;
3. editable description;
4. manual Waiting conditions, when present;
5. After relationships, when present;
6. Tasks, when present (ordering and gestures: `docs/entities/task.md`).

Waiting and After are never Task-list footers and receive no Task gestures,
reorder behavior, dividers, or row spacing. Empty relationship regions have no
heading, prompt, input, helper copy, or local add control.

On mobile, a dirty description queues an optimistic edit before another
workspace action or navigation continues. Blank description text clears the
stored value to `null`.

The main Add control opens the shared drawer directly with Task selected and
Task, Waiting, After, and Project selectors visible. Once a region exists, its
local `+` opens that drawer with the matching selector active. After opens its
filtered Project picker above the drawer. The status control remains
lifecycle-only.

## Completion feedback

Task completion persists immediately. A Project Task's transient feedback names
and links its Project and offers Undo plus **Waiting for…**, which opens the
shared add drawer with Waiting selected, labels the destination **Project**, and
labels the **What needs to happen?** field **Waiting on**. Loose Tasks omit
Project actions.

Project completion also persists immediately and offers Undo. There are no
notifications when an After relationship resolves.

## Storage and REST interfaces

`TaskDO` owns Project rows and coordinates Project state with Task and
Waiting/After rows for completion, Undo, and deletion.

Per-user Project routes remain:

- `GET /api/projects`;
- `POST /api/projects`;
- `PATCH /api/projects/{id}`;
- `DELETE /api/projects/{id}`;
- `POST /api/projects/icon-suggestions`.

The shared account replica's `projects` group exposes `add`, `setState`,
`reopen`, `edit`, and `remove`. It retains terminal rows so Undo can reopen a
Done Project. Synchronization refresh belongs to the account replica rather
than an individual entity collection.

## Related entities

- Task membership uses nullable `Task.projectId`.
- Manual Waiting conditions are documented in
  `docs/entities/waiting-condition.md`.
- Project After relationships are documented in
  `docs/entities/project-after.md`.
- Dates belong only to Tasks.
