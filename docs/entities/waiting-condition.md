# Waiting condition

A Waiting condition is a Project-scoped text condition that requires human
review and manual resolution. Examples include “Breeder replies” and “Tax office
sends the assessment.”

This file is the source of truth for manual Waiting behavior. Automatic Project
sequencing is a separate concept documented in `project-after.md`.

## Data shape

Manual Waiting shares the private `waiting_conditions` table with After rows,
but its domain shape is exact:

- `id` — client-minted UUID;
- `projectId` — owning Project;
- `kind` — fixed `free-text` storage tag;
- `text` — required non-empty prose;
- `refId` — always null;
- `targetStatus` — always null;
- `resolvedAt` — null while open, then the first resolution timestamp;
- `createdAt` — ISO timestamp.

The tagged table is an implementation detail. Callers use `addWaiting(projectId,
text)` and never construct storage tags.

## Behavior

- A Project can have several manual conditions.
- Every condition remains visible and resolves independently.
- An In-play Project is Waiting while any manual condition remains open unless
  an arrived dated Task makes it Active.
- Manual Waiting outranks After.
- Resolve sets `resolvedAt` and removes the row from the open client collection.
- Remove hard-deletes one condition without affecting the others.
- Deleting the owning Project deletes every manual condition it owns.

Task references, arbitrary Project statuses, Project-level dates, exact times,
and Calendar events are invalid. Migration 0056 removes historical rows of those
kinds.

## Presentation

The Project workspace places all open manual conditions under **Waiting on**
before After and Tasks. Text wraps in full. Every row has a full-size Resolve
action and separately labelled removal management.

When no manual conditions exist, the heading, rows, add control, input, helper
copy, and empty state are absent. The first condition comes from the Project Add
surface. A non-empty section gains a local `+` for another condition.

Every mobile entry point opens the shared Project add drawer with **Waiting**
selected. The drawer keeps Task, Waiting, After, and Project visible, identifies
the destination under **Project** with its icon and title, and labels the **What
needs to happen?** field **Waiting on**. Its circular add action submits the
condition. There is no standalone form or condition-kind selector.

Completing a Project Task offers **Waiting for…** in transient feedback. It opens
the same drawer for that Task's Project without delaying or owning the
completion write.

## Persistence interface

Per-user REST routes remain `/api/waits` for list, add, resolve, and delete. The
request schema accepts only manual free text or the separate exact After storage
variant; no generic kind can be created.

The shared collection exposes purpose-specific `addWaiting`, `resolveWaiting`,
and `remove` verbs. Reads are local-first and writes use the existing durable
offline outbox.
