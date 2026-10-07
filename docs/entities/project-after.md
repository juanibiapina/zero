# After

## What it is

After says that one Project needs no attention until another Project is Done:
"Buy a dog after Buy a house".

## Why it is its own block

The app can resolve it without you. When the other Project is Done, After goes
away and the Project comes back by itself. It describes when you want to look
at a Project, not why. A real prerequisite and a simple preference look the
same.

## Rules

- A Project can follow several Projects. It stays After until all of them are
  Done.
- It points only at another Project. It never points at itself, at a Done
  Project, or in a circle.
- Active and Waiting outrank After. Dating a Task brings the Project forward
  and leaves After in place.
- After never moves a Task date and never hides a Task with an arrived date
  from Home.

## How it looks

The Project workspace shows an "After" section after Waiting and before Tasks.
Each row shows the other Project's icon and title and opens it. The Projects
list has an After group, collapsed by default.

## Interactions

- Project: completing the other Project resolves the After. Undo restores it.
  Deleting either Project removes the relationship.
- Waiting: ranks below it.
- Task: none.
- Medicine: none.
- Agents: list, add, and delete.

## Left out on purpose

- A notification when After resolves.
- After on Tasks or on dates.
