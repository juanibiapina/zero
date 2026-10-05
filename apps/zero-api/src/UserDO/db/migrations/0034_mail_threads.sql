-- Watched Gmail threads: one row per thread Zero should notice replies on.
--
-- A row is bound to the conversation it speaks in, exactly like `schedules`,
-- and dies with it: resetting a chat drops what was being watched there,
-- because the notification has no other thread to land in.
--
-- There is deliberately no historyId column here. Gmail's `historyId` is a
-- MAILBOX sequence number, not a thread property, and one `history.list` call
-- covers every watched thread at once, so the watermark is a single value on
-- `user_settings`. Per-row watermarks would also rot: a thread that receives
-- nothing for a week would fall outside Gmail's history retention while an
-- active mailbox kept moving.
CREATE TABLE "mail_threads" (
  "threadId" TEXT PRIMARY KEY NOT NULL,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id"),
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TEXT NOT NULL,
  "lastNotifiedAt" TEXT DEFAULT NULL
);
--> statement-breakpoint
CREATE INDEX "mail_threads_conversation" ON "mail_threads" ("conversationId");
--> statement-breakpoint
-- The mailbox watermark every poll advances, and the last time the user did
-- anything. Together they decide whether the hourly poll runs at all.
ALTER TABLE "user_settings" ADD COLUMN "mailHistoryId" TEXT DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "lastActiveAt" TEXT DEFAULT NULL;
