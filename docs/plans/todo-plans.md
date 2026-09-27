# Todo plans that remain current

Completed todo execution plans are preserved in Git history rather than kept in
the live documentation tree. The remaining files have one of two purposes.

## Active direction

- `todo-quick-add-morph.md` covers the remaining mobile FAB-to-bar transition.
  Completed Task row-removal animation work stays in Git history.
- `todo-task-to-project-ai.md` is the still-open AI-assisted refinement
  direction for turning a loose Task into a proposed Project and Tasks.

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
behavior. Completed execution prose, including the removed animation increment,
remains in Git history rather than in a second live archive. The repository
history before commit `ef8a3dbabe915964907d2dbeb7b6671444d3b322` also retains
the earlier removed execution plans.
