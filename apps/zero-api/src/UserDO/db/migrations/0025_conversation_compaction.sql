-- Per-conversation compaction: a boundary and a summary of everything up to it.
--
-- Compaction is non-destructive. No message is ever deleted: the boundary only
-- moves, and what the model sees becomes `summary + messages after boundary`.
-- Learning still reads the raw log, which is why the rows must stay.
--
-- Both columns are NULL until a conversation has been compacted, which means
-- "show the whole log" and is the state every existing conversation starts in.
ALTER TABLE "conversations" ADD COLUMN "compactedThroughMessageId" INTEGER DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary" TEXT DEFAULT NULL;
