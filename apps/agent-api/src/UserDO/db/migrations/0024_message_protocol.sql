-- The conversation log becomes a real agent protocol log.
--
-- `content` stops being plain text and becomes a JSON array of wire-format
-- content blocks, so tool calls, tool results and images survive between turns
-- instead of being re-fetched. Every existing row is rewritten as a single text
-- block, so no text is lost and no reader has to guess an encoding.
--
-- `kind` names what a row is (user_message / assistant_message / tool_result),
-- `stopReason` records why a model response ended, and `consolidatedAt` marks
-- the rows learning has already folded into topics.
--
-- Legacy assistant rows get stopReason 'end_turn': the old code only ever
-- persisted finished replies, and without it every historical conversation
-- would look like it still needed a model response.
ALTER TABLE "messages" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user_message';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "stopReason" TEXT DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "consolidatedAt" TEXT DEFAULT NULL;
--> statement-breakpoint
UPDATE "messages" SET
  "kind" = CASE WHEN "role" = 'assistant' THEN 'assistant_message' ELSE 'user_message' END,
  "stopReason" = CASE WHEN "role" = 'assistant' THEN 'end_turn' ELSE NULL END,
  "content" = json_array(json_object('type', 'text', 'text', "content"));
--> statement-breakpoint
-- Telegram messages land here first and are injected into the transcript at a
-- safe point, so a message arriving mid-run is neither lost nor spliced into a
-- request the model is already answering. `injectedAt` marks a drained row.
CREATE TABLE "pending_messages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id"),
  "content" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "injectedAt" TEXT DEFAULT NULL
);
--> statement-breakpoint
-- One row per assistant text block that has been handed to Telegram. Claimed
-- before the send leaves, so a resumed run never sends the same block twice.
CREATE TABLE "deliveries" (
  "messageId" INTEGER NOT NULL REFERENCES "messages"("id"),
  "blockIndex" INTEGER NOT NULL,
  "claimedAt" TEXT NOT NULL,
  PRIMARY KEY ("messageId", "blockIndex")
);
