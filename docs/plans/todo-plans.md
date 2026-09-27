# Todo plans that remain current

Completed todo execution plans are preserved in Git history rather than kept in
the live documentation tree. The remaining files have one of two purposes.

## Active direction

- `todo-capture-animations.md` retains the unimplemented quick-add morph. Its
  completed row-removal animation remains in the same plan for context.
- `todo-task-to-project-ai.md` is the still-open AI-assisted refinement
  direction. Its Capture terminology records the original exploration; current
  work must adapt the idea to the Task-only model documented in
  `docs/entities/task.md`.

## Historical decisions

- `todo-availability-model.md` records the introduction of calculated Project
  availability and the schema migrations that established it. Current behavior
  lives in the entity documents.
- `todo-single-list-overview.md` records why Capture was collapsed into Task.
- `todo-local-replica-task-do-slice1.md` records the first TaskDO proof and its
  safety constraints.
- `todo-local-replica-sync.md` records the completed TaskDO/local-replica
  cutover, including migration and recovery evidence.

Use `docs/todo-app.md`, `docs/entities/`, and `docs/storage.md` for present-state
behavior. The repository history before commit
`ef8a3dbabe915964907d2dbeb7b6671444d3b322` retains the removed execution plans.
