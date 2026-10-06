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

`projects` is a logical table in each account's TaskDO TinyBase store. The same
rows are replicated to the account-scoped client store. Client-facing Project:

- `id` — client-minted UUID and exactly-once insert key;
- `title` — required outcome name;
- `icon` — one emoji, default 📁;
- `description` — nullable free text;
- `state` — `in-play | backlog | done`, default `in-play`;
- `createdAt` — ISO timestamp.

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
- **Suggest icons** — `POST /api/projects/icon-suggestions` returns up to six
  emoji for a title and optional description, through the shared
  `@zeroapps/emoji-suggest` package and TypeSafe's Jev (`jev-1.13.0`, key
  `TYPESAFE_API_KEY`). See `packages/emoji-suggest/README.md` for how it picks
  them. Any failure returns no icons. Each request logs
  `project_icon_suggested` with its count, input tokens, and latency. On
  2026-10-06 it suggested the hand-picked icon for 15 of 19 real Projects (the
  previous LLM: 14), gave all 12 test titles naming a country, city, people, or
  language that country's flag, and answered in 699 ms median and 877 ms p95,
  against about 2.3 s before.
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

Projects-list creation starts on Project with Task also available on both
surfaces. Creating a Project opens its workspace; creating a Task stays on the
list. Task creation choices and draft rules live in
[`task.md`](task.md).

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

On mobile, dirty title and description drafts queue an optimistic edit before
another workspace action or navigation continues, including the **Back to
projects** button. Titles are trimmed; a blank title restores the stored title.
Blank description text clears the stored value to `null`.

Mobile Add opens the shared drawer directly with Task selected. Web Add offers
Task, Waiting condition, After project, or Project and then opens the shared
creation sheet. Once a region exists, its local `+` opens the matching flow.
After offers only eligible Projects.

The status control precedes description, explains the current calculated
attention, and offers manual lifecycle actions: Complete, Move to backlog,
Move out of backlog, or Reopen, as applicable. Deletion stays in Project
actions.

## Completion feedback

Task completion behavior and its contextual Waiting flow live in
[`task.md`](task.md). On web, transient feedback has a keyboard-operable dismiss
control and clears on navigation or browser backgrounding. Save failures stay
visible until dismissed or a successful retry resolves them.

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
