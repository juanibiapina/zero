-- DATA LOSS: the Zero agent is removed. Every table below held only agent data
-- (conversations, learned topics, files, schedules, watched mail, the Telegram
-- link). Children drop before their parents so foreign keys never block a drop.
DROP TABLE IF EXISTS "deliveries";
--> statement-breakpoint
DROP TABLE IF EXISTS "pending_messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_threads";
--> statement-breakpoint
DROP TABLE IF EXISTS "schedules";
--> statement-breakpoint
DROP TABLE IF EXISTS "conversations";
--> statement-breakpoint
DROP TABLE IF EXISTS "topic_links";
--> statement-breakpoint
DROP TABLE IF EXISTS "topics";
--> statement-breakpoint
DROP TABLE IF EXISTS "knowledge";
--> statement-breakpoint
DROP TABLE IF EXISTS "files";
--> statement-breakpoint
DROP TABLE IF EXISTS "external_calls";
--> statement-breakpoint
DROP TABLE IF EXISTS "learning_jobs";
--> statement-breakpoint
DROP TABLE IF EXISTS "processed_updates";
--> statement-breakpoint
DROP TABLE IF EXISTS "telegram_link";
--> statement-breakpoint
DROP TABLE IF EXISTS "sessions";
--> statement-breakpoint
CREATE TABLE "user_settings_new" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "createdAt" TEXT DEFAULT NULL,
  "timezone" TEXT DEFAULT NULL
);
--> statement-breakpoint
INSERT INTO "user_settings_new" ("id", "createdAt", "timezone")
  SELECT "id", "createdAt", "timezone" FROM "user_settings";
--> statement-breakpoint
DROP TABLE "user_settings";
--> statement-breakpoint
ALTER TABLE "user_settings_new" RENAME TO "user_settings";
