-- Partial index for the Inbox query (WHERE processedAt IS NULL ORDER BY
-- createdAt). Indexes only open rows, so it stays small as processed captures
-- accumulate, and serves both the filter and the sort with no table scan.
CREATE INDEX "captures_inbox" ON "captures" ("createdAt") WHERE "processedAt" IS NULL;
