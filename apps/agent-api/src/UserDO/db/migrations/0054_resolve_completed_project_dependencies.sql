-- Persist Project-completion settlement before a Done target leaves clients'
-- working Project collections, and repair historical rows that predate
-- server-owned settlement. A later reopen can restore these rows.
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
