-- Task ↔ Project membership: a Task may belong to a Project, or be loose. The
-- column is nullable (loose tasks have NULL projectId), and ADD COLUMN cannot be
-- NOT NULL on a populated table anyway. No foreign key: the store owns the
-- relationship and a deleted project simply leaves its tasks loose. See
-- docs/entities/task.md and https://github.com/juanibiapina/zero/blob/574911e0df656ba5923198819c9ec5d061f623c6/docs/plans/todo-availability-model.md (slice 2).
ALTER TABLE "tasks" ADD COLUMN "projectId" TEXT;
