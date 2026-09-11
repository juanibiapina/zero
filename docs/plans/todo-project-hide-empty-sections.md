# Hide empty Tasks / Waiting sections on the mobile project screen

## Goal

On the mobile todo app's project screen (`apps/agent-mobile`), the "Tasks" and
"Waiting on" sections render nothing but a bare heading when they hold no rows.
A fresh project therefore shows two orphan headings under the description. Make
each section render **nothing at all** when it is empty, so the screen leads
straight from the description to whatever work actually exists — or to just the
add FAB on a brand-new project.

## Context

The project screen is `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`.
Two of its sub-modules own the affected sections:

- `ProjectTasks` — runs a live query for the project's open tasks, renders a
  "Tasks" `<Text variant="section">` heading followed by one row per task.
- `ProjectWaits` — runs a live query for the project's waiting conditions,
  renders a "Waiting on" heading followed by one row per condition.

Both always render the heading, even when the mapped list is empty. Adding a
task or a waiting condition is **not** inline in these sections; it happens
through the screen's plus FAB (the quick-add bar's Task and Waiting modes). So
hiding an empty section removes no add affordance — the FAB is the only add
path, and it stays.

Each section computes its `list` after its `useLiveQuery` call. React's
rules-of-hooks are satisfied by keeping the hook unconditional and returning
early only after `list` is known.

## What to change and why

In `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`:

- `ProjectTasks`: after computing `list`, `return null` when `list.length === 0`.
  The live query still runs (hook stays above the guard), so the section appears
  the instant the first task is added.
- `ProjectWaits`: same — after computing `list`, `return null` when
  `list.length === 0`.

No shared logic, no new module: this is two one-line guards behind existing
interfaces. The sections are already separate, shallow view modules; the guard
belongs inside each because each owns its own emptiness.

## Out of scope

- **The web project screen** (`apps/agent-web/src/pages/ProjectDetailPage.tsx`).
  Its `ProjectTasks` and `ProjectWaits` already hide their **rows** when empty
  (the `<ul>` is gated on `list.length > 0`) but deliberately keep the heading
  plus an **inline** add control (the "Add a task" form and the "+ Waiting
  condition" popover). Hiding the whole section there would remove the only way
  to add on web, which has no FAB. That is a different design decision; this plan
  does not touch web.
- Any change to when/how tasks or conditions are added, ordered, or completed.

## Tests to add or update

File: `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx`
(the default fixture already resolves empty tasks and empty waits, so an empty
project is the default render).

- Add: with no open tasks, the "Tasks" heading is absent
  (`queryByText('Tasks')` is null).
- Add: with no waiting conditions, the "Waiting on" heading is absent.
- Add: with at least one open task, the "Tasks" heading is present (guards
  against a regression that hides a non-empty section). A waiting-present
  counterpart is optional given the symmetric implementation.

Confirm the existing tests still pass; none assert the empty-section headings
today, so hiding them should not break them.

## Docs to add or update

Add one bullet to `apps/agent-mobile/CHANGELOG.md`, most recent first, from the
user's perspective, e.g.:

`- YYYY-MM-DD: A project's screen no longer shows an empty "Tasks" or "Waiting on" heading — each section appears only once it has something in it. Add either from the + button.`

## Skills to use

- `tdd` — write the two absent-heading tests first, watch them fail, then add
  the guards.
- `changelog` — load before editing `apps/agent-mobile/CHANGELOG.md`.
- `git-commit` — when committing.

## Acceptance criteria

- A project with no open tasks shows no "Tasks" heading on the mobile screen.
- A project with no waiting conditions shows no "Waiting on" heading.
- Adding the first task (or condition) via the FAB makes the corresponding
  section appear immediately.
- A project that has tasks and/or conditions still shows the relevant
  heading(s) and rows.
- `apps/agent-mobile` unit tests, lint, and typecheck pass
  (`pnpm --filter @zero/agent-mobile run test|lint|typecheck`).
- The change is verified on the real Pixel 7 with a throwaway project (create
  one, confirm no empty headings; add a task and a waiting condition, confirm
  each section appears; delete the project when done), per `AGENTS.md`.
- A `apps/agent-mobile/CHANGELOG.md` entry ships in the same commit.
