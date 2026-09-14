-- Separate persisted project lifecycle from calculated display status.
-- Active, Next, and Waiting were already derived by clients; their stored values
-- all mean that the project is in play. Rename the column and normalize those
-- legacy values while preserving every project row.
CREATE TABLE "projects_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "icon" TEXT NOT NULL,
  "description" TEXT,
  "state" TEXT NOT NULL DEFAULT 'in-play',
  "createdAt" TEXT NOT NULL,
  "sourceCaptureId" TEXT
);

INSERT INTO "projects_new" (
  "id", "title", "icon", "description", "state", "createdAt",
  "sourceCaptureId"
)
SELECT
  "id",
  "title",
  "icon",
  "description",
  CASE
    WHEN "status" IN ('active', 'next', 'waiting') THEN 'in-play'
    ELSE "status"
  END,
  "createdAt",
  "sourceCaptureId"
FROM "projects";

DROP TABLE "projects";
ALTER TABLE "projects_new" RENAME TO "projects";

CREATE INDEX "projects_open" ON "projects" ("createdAt") WHERE "state" != 'done';
