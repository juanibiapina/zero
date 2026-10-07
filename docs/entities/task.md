# Task

## What it is

A Task is one line of work: "buy milk", "call the breeder", "renew passport".
It is the entry point of the app. Anything you jot down becomes a Task. A Task
can stand alone (a loose Task) or belong to a Project.

## Why it is its own block

Task is the only thing that goes in the list of work. It owns the things a list
needs: a text, an optional date, an optional repeat, a place in the manual
order, and completion. Everything else in the app either groups Tasks or
explains why they cannot happen yet.

## Rules

- The date is the commitment. A Project Task reaches Home only when it has a
  date and that date arrived. Without a date, it is groomed: it waits on its
  Project screen until you commit to it.
- A loose Task without a date is always relevant and stays on Home.
- A future date parks any Task in Upcoming. It returns to Home on its day.
- A repeating Task stays one Task. Completing it moves it to the next date.
  "Every" counts from the planned date and can stay overdue to catch up. "Every!"
  counts from the day you complete it. The Task leaves only when the repeat ends.
- There is one manual order. Home and each Project show slices of it, and moving
  a Task in either place moves it everywhere.
- Completion happens at once and can be undone.
- Dates follow the user's local day.

## How it looks

A row with a circle to complete it and its text. A repeating Task shows a small
repeat mark and its rule under the text, such as "every Monday" or "after
completion". Typing a date or repeat into the title highlights the phrase and
turns it into the schedule. Tapping the phrase keeps the words as plain text.

## Interactions

- Project: a Task belongs to at most one Project. A Task with an arrived date
  makes its Project Active. A Task with a future date makes its Project Waiting
  until that day. Deleting a Project deletes its Tasks. Moving a Task into a
  Project keeps its date.
- Waiting: completing a Project Task offers "Waiting for…", to record what the
  Project now waits for.
- After: none. After never hides a Task you dated on purpose.
- Medicine: none.
- Home: shows the Tasks that are open and available today.
- Upcoming: shows open Tasks with a future date, grouped by day.
- Quick add: while you type a new Task, Zero suggests the Project it most likely
  belongs to. Choosing a Project or "No project" by hand ends the suggestion.
- Agents: list, add, edit, complete, reopen, and set repeats.

## Left out on purpose

- Priorities, subtasks, and labels. They went unused in Todoist.
- A separate inbox. See Capture under Removed blocks in the
  [README](README.md).
- A separate "take on" step. Giving a Task a date is the commitment.

## Ideas

- Zero proposes a Project and Tasks from a loose Task, and commits only after
  you confirm. See [`todo-task-to-project-ai.md`](../plans/todo-task-to-project-ai.md).
