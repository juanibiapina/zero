-- Topics keep one knowledge document (the body). Legacy summaries are folded
-- into the body before the column goes, so no text is lost: skip empty ones,
-- skip a summary the body already contains verbatim, use it as the body when
-- the body is empty, otherwise append it under a "## Legacy summary" heading.
-- Link rows are re-derived from every body once after this migration, in the
-- DO (see UserDO/index.ts): [[Name]] tokens may arrive with the folded text.
UPDATE "topics" SET "body" = CASE
  WHEN "summary" = '' THEN "body"
  WHEN "body" = '' THEN "summary"
  WHEN instr("body", "summary") > 0 THEN "body"
  ELSE "body" || char(10) || char(10) || '## Legacy summary' || char(10) || char(10) || "summary"
END;
--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "summary";
