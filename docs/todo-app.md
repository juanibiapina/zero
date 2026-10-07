# From Todoist to Full Assistant

This document holds the todo product vision and roadmap. The entities and how
they interact are in [`docs/entities/`](entities/README.md). How the app stores
and synchronizes data is in [`docs/storage.md`](storage.md), and how local
agents reach it is in [`docs/mcp.md`](mcp.md). Shipped changes are in the
[mobile](../apps/agent-mobile/CHANGELOG.md) and
[web](../apps/zero-web/CHANGELOG.md) changelogs.

## North star

Replace Todoist as the single entry point to all tasks, then let that entry
point absorb the surrounding workflows: email processing, calendar, AI coding,
and life-project management. Build it inside Zero as a parallel product surface
without disturbing the conversational agent, and dogfood Zero's own services.

## Design philosophy

### Entities are blocks

Each entity is a new block in a game. Adding one means deciding how it looks
and how it behaves next to every other block. See
[`docs/entities/README.md`](entities/README.md).

### Current work must remain trustworthy

Home contains work that deserves attention now. Projects keep the work that
does not. Your lifecycle choices stay separate from the attention the app
calculates, and completing something saves at once.

### Local state is user data

Mobile and web work on the device first. A client without a connection stays
useful, and a write it accepted survives a restart and reaches the server when
the connection returns.

## Surfaces

- Home: the Tasks available today, and the place to add new work.
- Upcoming: Tasks with a future date.
- Projects: Projects grouped by attention, each with its own workspace.
- Medicines: medicine routines and their doses.

Mobile is the main daily surface, and web is the companion. Both show the same
model, and both work before sign-in.

## Roadmap

1. AI-assisted Task refinement. Let the agent propose a Project and Tasks from a
   loose Task, then commit only after explicit confirmation. The open design
   choices are in
   [`todo-task-to-project-ai.md`](plans/todo-task-to-project-ai.md).
2. Connect the agent to todo workflows. Resolve Waiting conditions from observed
   email, calendar, or content, then add carefully scoped todo write tools where
   a confirmed workflow needs them.

The active and historical plan index is
[`docs/plans/todo-plans.md`](plans/todo-plans.md).
