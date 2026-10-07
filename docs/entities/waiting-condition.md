# Waiting condition

## What it is

A Waiting condition is something a Project waits for, written in your own
words: "Breeder replies", "Tax office sends the assessment".

## Why it is its own block

Only a person can tell when it is true. The app does not check it. It keeps
the Project out of the way and keeps the reason in view until you resolve it.

## Rules

- A condition belongs to one Project.
- A Project can have several. Each resolves on its own.
- While one is open, a Project in play is Waiting, unless one of its Tasks has
  an arrived date.
- Waiting outranks After.
- The text is free prose. A condition does not point at a Task, a date, or a
  calendar event.

## How it looks

Open conditions appear under "Waiting on" in the Project workspace, before
After and Tasks. The full text wraps. Each row has a Resolve action. With no
open condition, the section is absent.

## Interactions

- Project: makes it Waiting. Deleting the Project deletes its conditions.
- Task: completing a Project Task offers "Waiting for…" to add a condition to
  that Project.
- After: Waiting ranks above it.
- Medicine: none.
- Agents: list, add, resolve, and delete.

## Left out on purpose

- Kinds of condition. Sequencing after another Project is its own block,
  [After](project-after.md).
- Conditions on Tasks, dates, or calendar events.

## Ideas

- Zero resolves a condition when it sees the answer in email, the calendar, or
  other content it reads.
