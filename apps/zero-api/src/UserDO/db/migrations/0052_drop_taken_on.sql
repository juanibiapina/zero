-- Retire take-on: drop the `takenOnAt` column. The show-up date is now the sole
-- commitment gate for a project task (a project task reaches Home only when its
-- date has arrived; committing a groomed task means dating it, not starring it).
-- See docs/entities/task.md for the current commitment model.
--
-- COLUMN DROP + BACKFILL, STATED LOUDLY: this removes `takenOnAt` from `tasks`.
-- Before dropping it, any project task that was taken on but had no date was on
-- Home purely by the star; to keep it on Home under the date-only gate, backfill
-- its `showUpDate` to the day it was taken on (a past date is <= today, so it
-- stays shown up). Rows that already have a date keep it; parked rows are
-- untouched. SQLite cannot drop a column and reproject in one ALTER, so the
-- table is rebuilt (same idiom as migration 0051).
CREATE TABLE "tasks_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "text" TEXT NOT NULL,
  "showUpDate" TEXT,
  "createdAt" TEXT NOT NULL,
  "completedAt" TEXT,
  "projectId" TEXT,
  "sourceCaptureId" TEXT,
  "sortKey" TEXT
);

INSERT INTO "tasks_new" (
  "id", "text", "showUpDate", "createdAt", "completedAt", "projectId",
  "sourceCaptureId", "sortKey"
)
SELECT
  "id",
  "text",
  CASE
    WHEN "showUpDate" IS NULL AND "takenOnAt" IS NOT NULL
      THEN date("takenOnAt")
    ELSE "showUpDate"
  END,
  "createdAt",
  "completedAt",
  "projectId",
  "sourceCaptureId",
  "sortKey"
FROM "tasks";

DROP TABLE "tasks";
ALTER TABLE "tasks_new" RENAME TO "tasks";

-- Rebuild the open-tasks partial index (dropped with the old table).
CREATE INDEX "tasks_open" ON "tasks" ("createdAt") WHERE "completedAt" IS NULL;
