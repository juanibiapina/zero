# Project

## What it is

A Project is an outcome you want, such as "Buy a house", "Get the diploma", or
"Adopt a dog". It groups the work toward that outcome and tells you how much
attention it needs right now.

## Why it is its own block

A Project calculates its attention. You decide only whether it is in play, in
the backlog, or done. The app works out the rest from its Tasks, its Waiting
conditions, and its After relationships. This keeps Home trustworthy: work
that does not need you now stays in its Project.

## Rules

- Your choice outranks the calculation. Backlog and Done always win.
- For a Project in play, the first match decides its status:
  1. Active: a Task has a date that arrived.
  2. Waiting: a Waiting condition is open, or a Task has a future date.
  3. After: another Project it follows is not Done yet.
  4. Next: anything else, including an empty Project.
- A Task without a date does not make a Project Active. It is groomed work.
- Dating a Task brings a Project forward without touching its After
  relationships. When that Task is done, After can return.
- Projects have no dates. Dates belong to Tasks.
- Completing a Project happens at once and can be undone.

## How it looks

Each Project has one emoji icon and a title, such as 🏠 Buy a house. While you
type a title, Zero suggests icons. A status pill explains the current
attention, for example "After · 🏠 Buy a house".

The Projects list groups Projects in this order: Active, Next, Waiting, After,
Backlog. Empty groups are absent. After starts collapsed, and Backlog collapses
when it is long. Every Project picker uses the same groups.

A Project opens its own workspace, in this order: title and icon, status and
lifecycle actions, description, Waiting conditions, After relationships, and
Tasks. Waiting and After appear only when they have something in them.

## Interactions

- Task: holds any number. A Task with an arrived date makes it Active. A Task
  with a future date makes it Waiting until that day. Deleting the Project
  deletes its Tasks.
- Waiting: owns any number. One open condition makes it Waiting. Deleting the
  Project deletes them.
- After: a Project can follow other Projects, and others can follow it.
  Completing it releases the Projects that follow it. Undo puts them back.
  Deleting it removes the relationship and warns which Projects can change
  group.
- Medicine: none.
- Home: when Home has no Tasks, it shows the Next and Waiting Projects.
- Agents: list, add, edit, change state, and delete.

## Left out on purpose

- Project dates and deadlines.
- Notifications when a Project it follows is Done.

## Ideas

- A Project could hold agent sessions and documents, and spin off other
  Projects or People.
- Project slots that start at one to teach the game.
- Templates that create a Project from a workflow.
