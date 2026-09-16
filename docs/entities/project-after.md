# Project After

A Project After relationship says that one Project needs no attention until
another Project is Done.

```text
Project A ──after──▶ Project B is Done
```

After models desired attention, not the reason for sequencing. “Buy a dog after
Buy a house” and a genuine prerequisite use the same relationship.

## Data shape

After shares the private `waiting_conditions` table with manual Waiting rows,
but its domain shape is exact:

- `id` — client-minted UUID;
- `projectId` — source Project;
- `kind` — fixed `project-status` storage tag;
- `text` — always null;
- `refId` — referenced Project id;
- `targetStatus` — fixed `done`;
- `resolvedAt` — null while open, set when the referenced Project completes;
- `createdAt` — ISO timestamp.

Callers use `addAfter(projectId, afterProjectId)` and never construct this tagged
storage representation.

## Graph rules

- A source Project can have several After relationships.
- Several relationships use AND semantics: After remains while any row is open.
- Only Projects can be referenced.
- The source Project, Done Projects, direct duplicates, and candidates that
  create direct or transitive cycles are invalid.
- Backlog Projects may retain After rows; Backlog remains dominant.

The client filters candidates for immediate feedback. The server repeats every
validation against authoritative state.

## Attention behavior

For an In-play Project, Active and Waiting both outrank After. Scheduling a Task
therefore brings the Project forward without resolving any relationship. When
that work completes, After can become dominant again.

After never changes Task dates and never suppresses an arrived Task from Home.
It is absent from a Projects-list row while Active or Waiting, but every open
relationship remains visible inside the Project workspace.

## Lifecycle

Completing a referenced Project atomically sets `resolvedAt` on every matching
incoming row before returning. Completing the final referenced Project lets the
source recalculate to Active, Waiting, or Next.

Undoing that completion atomically reopens the Project and clears `resolvedAt`
on the relationships resolved by its completion. The client refetches the open
relationship collection after both transitions.

Deleting a referenced Project removes incoming rows and warns which source
Projects may move to another section. Deleting a source removes its outgoing
rows. Removing one of several rows leaves the others active.

There is no notification when After resolves.

## Presentation

Projects uses an **After** section after Waiting and before Backlog. It is absent
when empty and collapsed by default.

The Project workspace shows an **After** region after manual Waiting and before
Tasks. Each row shows the referenced Project's icon and title, navigates to that
Project, and has separately labelled removal management. It does not say “Must
be completed first.”

The first relationship comes from the Project Add surface's **After project**
action. A non-empty After region gains a local `+` that opens the same searchable
Project picker.
