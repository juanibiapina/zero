-- Project attention now has exactly two persisted variants: manual free-text
-- Waiting and Project-completion After. Remove every historical generic variant
-- and malformed row before adding the direct-relationship uniqueness guard.
DELETE FROM "waiting_conditions"
WHERE NOT (
  (
    "kind" = 'free-text'
    AND "text" IS NOT NULL
    AND length(trim("text")) > 0
    AND "refId" IS NULL
    AND "targetStatus" IS NULL
  )
  OR
  (
    "kind" = 'project-status'
    AND "text" IS NULL
    AND "refId" IS NOT NULL
    AND "targetStatus" = 'done'
    AND "projectId" != "refId"
  )
);

-- Keep one deterministic row for any direct duplicate created before server-side
-- graph validation existed. Resolved rows remain because reopening their target
-- must be able to restore the relationship settled by completion.
DELETE FROM "waiting_conditions"
WHERE "kind" = 'project-status'
  AND "targetStatus" = 'done'
  AND "id" NOT IN (
    SELECT coalesce(
      min(CASE WHEN "resolvedAt" IS NULL THEN "id" END),
      min("id")
    )
    FROM "waiting_conditions"
    WHERE "kind" = 'project-status' AND "targetStatus" = 'done'
    GROUP BY "projectId", "refId"
  );

CREATE UNIQUE INDEX "project_after_unique"
ON "waiting_conditions" ("projectId", "refId")
WHERE "kind" = 'project-status' AND "targetStatus" = 'done';
