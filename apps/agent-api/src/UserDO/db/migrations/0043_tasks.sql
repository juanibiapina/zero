-- Tasks: the Today list for the parallel todo app. A Task is a typed, clarified
-- next-action with a day, distinct from a Capture (the untyped Inbox entry).
-- Standalone from the agent's tables; owned by DbTaskStore. `id` is a
-- client-minted UUID; open tasks are the rows where completedAt IS NULL;
-- showUpDate is the local day the task is due.
CREATE TABLE "tasks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "text" TEXT NOT NULL,
  "showUpDate" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "completedAt" TEXT
);

-- Partial index for the open-tasks query (WHERE completedAt IS NULL ORDER BY
-- createdAt). Indexes only open rows, so it stays small as completed tasks
-- accumulate.
CREATE INDEX "tasks_open" ON "tasks" ("createdAt") WHERE "completedAt" IS NULL;
