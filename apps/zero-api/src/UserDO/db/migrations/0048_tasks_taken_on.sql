-- Curation: when the user "took on" a task (made it show up on Home), or NULL
-- when it is parked. Nullable; ADD COLUMN cannot be NOT NULL on a populated
-- table. Only meaningful for tasks that belong to a project — loose tasks always
-- show on Home. See docs/entities/task.md and
-- https://github.com/juanibiapina/zero/blob/574911e0df656ba5923198819c9ec5d061f623c6/docs/plans/todo-availability-model.md (slice 4).
ALTER TABLE "tasks" ADD COLUMN "takenOnAt" TEXT;
