-- Delivery watermark: the newest message that existed before delivery claims did.
--
-- `deliveries` (migration 0024) starts empty, so every assistant row written by
-- the code that sent before persisting has no claim. The delivery retry reads
-- "no claim" as "persisted but never sent" and would resend the last reply of
-- every existing conversation, once, on the first alarm after the deploy. That
-- happened in production on 2026-07-30.
--
-- The watermark says where that ambiguity ends: rows at or below it were sent by
-- the old path and are done. Rows above it are governed by claims, so a reply
-- lost to a reset is still recoverable, which is the whole point of the retry.
--
-- NULL means "no history predates claims" and is the right value for a
-- conversation created from here on.
ALTER TABLE "conversations" ADD COLUMN "deliveredThroughMessageId" INTEGER DEFAULT NULL;
--> statement-breakpoint
UPDATE "conversations"
SET "deliveredThroughMessageId" = (
  SELECT MAX("id") FROM "messages" WHERE "messages"."conversationId" = "conversations"."id"
);
