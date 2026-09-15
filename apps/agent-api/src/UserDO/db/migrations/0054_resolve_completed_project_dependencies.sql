-- Project-completion dependencies are terminal milestones. Persist settlement
-- before a Done prerequisite leaves clients' working Project collections, and
-- repair historical rows that predate server-owned settlement.
UPDATE "waiting_conditions"
SET "resolvedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "kind" = 'project-status'
  AND "targetStatus" = 'done'
  AND "resolvedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "projects"
    WHERE "projects"."id" = "waiting_conditions"."refId"
      AND "projects"."state" = 'done'
  );
