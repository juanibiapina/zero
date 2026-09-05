-- Waiting conditions: why a project is waiting. A project may carry one or more;
-- any unresolved one makes the project display as `waiting` and hides its tasks
-- from Home. Distinct kinds:
--   'free-text'      -- a prose condition ("the letter comes back"); resolved by
--                       hand or the AI (resolvedAt set).
--   'task-done'      -- refId is a task id; satisfied (in code) when that task
--                       is completed.
--   'project-status' -- refId is a project id, targetStatus the status it must
--                       reach; satisfied (in code) when it does.
-- Structured kinds are derived-satisfied on the client (no resolvedAt); only
-- free-text persists resolvedAt. `id` is a client-minted UUID. Standalone from
-- the agent's tables; owned by DbWaitingConditionStore. See
-- docs/entities/waiting-condition.md and docs/plans/todo-availability-model.md.
CREATE TABLE "waiting_conditions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT,
  "refId" TEXT,
  "targetStatus" TEXT,
  "resolvedAt" TEXT,
  "createdAt" TEXT NOT NULL
);

-- Partial index for the open-conditions query (WHERE resolvedAt IS NULL). Only
-- free-text conditions are ever persisted-resolved; structured kinds stay open
-- and the client computes their satisfaction.
CREATE INDEX "waiting_conditions_open" ON "waiting_conditions" ("projectId") WHERE "resolvedAt" IS NULL;
