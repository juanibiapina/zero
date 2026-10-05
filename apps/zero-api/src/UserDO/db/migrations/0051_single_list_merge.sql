-- One list: collapse Capture into Task. Task becomes the single entity and the
-- app's entry point; the Capture entity is deleted. See
-- Historical plan: https://github.com/juanibiapina/zero/blob/ef8a3dbabe915964907d2dbeb7b6671444d3b322/docs/plans/todo-single-list-1-merge.md
--
-- DATA LOSS, STATED LOUDLY: this drops the `captures` table outright. Capture
-- data is disposable (a raw inbox line); there is NO copy into `tasks`. Task
-- data is preserved in full by the table rebuild below.
DROP INDEX IF EXISTS "captures_sort";
DROP INDEX IF EXISTS "captures_inbox";
DROP TABLE IF EXISTS "captures";

-- Reshape `tasks`, keeping every row. Two changes:
--   1. `showUpDate` becomes NULLABLE — a loose quick-capture has no day (NULL =
--      always relevant). SQLite ALTER cannot drop a column's NOT NULL in place,
--      so the table is rebuilt.
--   2. add `sortKey` (fractional-index manual order, nullable = unkeyed sorts
--      last). Every row is keyed in practice: `add` mints a trailing key,
--      `reorder` sets one, and the DO-init backfill (DbTaskStore.backfillSortKeys)
--      keys preserved rows in createdAt order so the merge keeps their order.
CREATE TABLE "tasks_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "text" TEXT NOT NULL,
  "showUpDate" TEXT,
  "createdAt" TEXT NOT NULL,
  "completedAt" TEXT,
  "projectId" TEXT,
  "takenOnAt" TEXT,
  "sourceCaptureId" TEXT,
  "sortKey" TEXT
);

INSERT INTO "tasks_new" (
  "id", "text", "showUpDate", "createdAt", "completedAt", "projectId",
  "takenOnAt", "sourceCaptureId", "sortKey"
)
SELECT
  "id", "text", "showUpDate", "createdAt", "completedAt", "projectId",
  "takenOnAt", "sourceCaptureId", NULL
FROM "tasks";

DROP TABLE "tasks";
ALTER TABLE "tasks_new" RENAME TO "tasks";

-- Partial index for the open-tasks query (WHERE completedAt IS NULL). Rebuilt
-- because the table was dropped. Kept on createdAt: it serves the open filter
-- and the createdAt tiebreak; sortKey ordering is applied in the store.
CREATE INDEX "tasks_open" ON "tasks" ("createdAt") WHERE "completedAt" IS NULL;
