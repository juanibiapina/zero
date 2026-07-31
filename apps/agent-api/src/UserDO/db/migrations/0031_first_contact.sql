ALTER TABLE "user_settings" ADD COLUMN "firstContactAt" TEXT DEFAULT NULL;
--> statement-breakpoint
-- Backfill: nobody mid-relationship gets a surprise "hi, I'm Zero".
-- COALESCE because createdAt was added later (0010) and is NULL on older rows.
-- Scoped to users who have actually talked to Zero: a settings row alone only
-- means the web app was opened, and someone who linked but never messaged
-- should still get the introduction.
UPDATE "user_settings"
SET "firstContactAt" = COALESCE("createdAt", '2026-07-31T00:00:00.000Z')
WHERE "firstContactAt" IS NULL AND EXISTS (SELECT 1 FROM "messages");
