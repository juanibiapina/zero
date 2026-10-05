# From Todoist to Full Assistant

This document holds the todo product vision, present architecture, and active
roadmap. Current entity behavior belongs in [`docs/entities/`](entities/), and
storage mechanics belong in [`docs/storage.md`](storage.md). User-visible
delivery history lives in the
[mobile](../apps/agent-mobile/CHANGELOG.md) and
[web](../apps/agent-web/CHANGELOG.md) changelogs.

## North star

Replace Todoist as the single entry point to all tasks, then let that entry
point absorb the surrounding workflows: email processing, calendar, AI coding,
and life-project management. Build it inside Zero as a parallel product surface
without disturbing the conversational agent, and dogfood Zero's own services.

## Design philosophy

### Entities are Minecraft blocks

Each entity type is a new block added to the system. Introducing one requires a
deliberate pass over how it looks, relates to every existing entity, participates
in workflows, persists, synchronizes, and fails, and which operations it
offers agents through the operation catalog (see [`docs/mcp.md`](mcp.md)). The
goal is specific behavior, not a generic relational builder.

### Current work must remain trustworthy

Home should contain work that deserves attention now. Projects preserve work
that does not. Manual lifecycle choices remain distinct from calculated
attention, and completion writes immediately rather than being owned by
transient UI.

### Local state is user data

Mobile and web are local-first clients. A disconnected client remains useful,
and acknowledged local writes must survive restart and converge when a
connection returns. Invalid synchronized rows retain their raw intent until a
safe repair is chosen. [`docs/storage.md`](storage.md) is the source of truth.

## Present state

### Product surfaces

- **Home** is the flat list of available Tasks and the default quick-add entry
  point. When that list is clear, Home shows all Next and Waiting Projects; if
  there are no current Projects, it gives a quiet explanation and leaves the
  existing add control as the only creation action.
- **Upcoming** contains future-dated Tasks.
- **Projects** groups outcomes by calculated attention and manual lifecycle
  state.
- A **Project workspace** holds identity, status, description, Waiting
  conditions, After relationships, and Tasks.
  Deleting a Project returns to the previous screen even with a description
  draft still focused; the outgoing workspace stays mounted through the native
  back transition, and navigation cleanup skips edits to removed Projects.

Mobile is the primary daily surface; web is the companion surface. Both expose
the same todo model. The current interaction details live in the entity docs.
Mobile launcher behavior, development, and device verification live in
[`apps/agent-mobile/README.md`](../apps/agent-mobile/README.md).

### Entity map

- **Medicine** defines a daily routine with one or more timed doses and an optional last day. **Dose** is a separate dated occurrence with its scheduled and recorded taken times. Manage both under Browse → Medicines; mobile creation uses the plus drawer with suggested daily times, and Android delivers normal notifications before and at dose time. See [`docs/entities/medicine.md`](entities/medicine.md).

- **Task** is the foundational entity and the only task-list item. It can be
  loose or belong to a Project, and it owns dates, recurrence, ordering, and
  completion. See [`docs/entities/task.md`](entities/task.md).
- **Project** is the outcome-oriented container. Its persisted lifecycle and
  calculated attention are separate. See
  [`docs/entities/project.md`](entities/project.md).
- **Waiting condition** is Project-scoped prose that requires human review and
  manual resolution. See
  [`docs/entities/waiting-condition.md`](entities/waiting-condition.md).
- **After** sequences one Project after another Project completes. See
  [`docs/entities/project-after.md`](entities/project-after.md).
- **Capture** is retired. The split between raw Capture and structured Task
  proved premature because the user worked in one list. Task absorbed the entry
  point, date, order, and visibility behavior. The concise tombstone is
  [`docs/entities/capture.md`](entities/capture.md); the rationale and migration
  decisions remain in the historical
  [`single-list plan`](plans/todo-single-list-overview.md).

Candidate future blocks include Person, Session, Email, Workflow, Vault, typed
notes such as Preference, and domain entities such as Trip, Invoice, or Movie
ticket. They are product ideas, not committed schema or implementation plans.

### Architecture

`TaskDO` is the sole server authority for synchronized todo data. A
platform-neutral TinyBase model in `@zero/agent-core` owns projections,
mutations, recurrence, ordering, relationships, and recovery. A shared Task
draft module owns title interpretation, schedule preview, dismissal, and commit
normalization for creation and editing. Mobile and web supply field-rendering
adapters and retain their workflow-specific submit and close policies. Both surfaces
work locally before sign-in and add guest work to the first account that signs
in. They expose the same screen-facing Task/Project/Waiting operations, and
bound clients synchronize with TaskDO over WebSocket. Platform ownership and
adoption policies live in [`docs/storage.md`](storage.md).

TaskDO retains Durable Object persistence, synchronization, erasure protection,
and typed REST mapping. Public todo REST routes remain for compatible installed
clients and other callers, but they reach the same TaskDO authority. External
agents such as pi use the MCP server, which runs operation catalog entries in
TaskDO; see [`docs/mcp.md`](mcp.md). `UserDO`
continues to own non-todo agent state; migration 0057 removes its retired todo
tables. See [`docs/storage.md`](storage.md) for the complete current model and
the historical
[`local-replica cutover plan`](plans/todo-local-replica-sync.md) for the rollout
evidence.

### Implementation status

The present Task, Project, Waiting, and After model is available on mobile and
web. Both open the same Home, Upcoming, Projects, and quick-add surfaces for
guests and signed-in users. Sign-in adds synchronization plus authenticated
timezone and icon-suggestion features. Guest screens omit those authenticated
requests. Web todo loading is independent of agent settings, so a failed
settings request does not block local work. Current clients also provide
offline writes, account isolation, recurrence, Undo, and recovery reporting. The product changelogs are
the record of shipped user-visible increments. On mobile Home, a static status
icon beside the account control appears only for device-saving problems or an
app update ready for the next launch. Its details include sync status, the last
successful sync, offline-copy availability, app version, and update lifecycle.
On web Home, the status icon reports local, connecting, syncing, synced, offline,
and storage-warning states; its details show the last successful sync and
offline-copy status:

- [`apps/agent-mobile/CHANGELOG.md`](../apps/agent-mobile/CHANGELOG.md)
- [`apps/agent-web/CHANGELOG.md`](../apps/agent-web/CHANGELOG.md)

The conversational agent does not yet refine a Task into a Project or resolve
Waiting conditions through email, calendar, or other observed content. Local
agents can read and change the todo workspace through the MCP server.

## Roadmap

1. **AI-assisted Task refinement.** Let the agent propose a Project and Tasks
   from a loose Task, then commit only after explicit confirmation. The open
   design choices are in
   [`todo-task-to-project-ai.md`](plans/todo-task-to-project-ai.md).
2. **Connect the agent to todo workflows.** Resolve Waiting conditions from
   observed email, calendar, or content, then add carefully scoped todo write
   tools where a confirmed workflow needs them.

The active and historical plan index is
[`docs/plans/todo-plans.md`](plans/todo-plans.md). Completed execution diaries
remain available in Git history instead of the live documentation tree.

## Verification and development

- Run focused package tests, lint, and typechecks while changing a surface.
- Run `gob run bin/ci` before completion.
- Test mobile behavior in Jest by default. Run
  `pnpm --filter @zero/agent-mobile e2e:pixel` when a change touches one of the
  critical phone seams: native persistence across restart, account binding and
  sync with the Worker, or native notifications. See "End-to-end tests" in
  [`apps/agent-mobile/README.md`](../apps/agent-mobile/README.md).
- Add user-visible changes to the affected product changelog. Internal
  refactors and documentation cleanup do not get changelog entries.
