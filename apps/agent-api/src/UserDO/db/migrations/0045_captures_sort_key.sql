-- Reorder: a capture's manual list position is a fractional-index sort key.
-- sortKey is a short base-62 string minted with generateKeyBetween; the list
-- orders by sortKey asc (createdAt asc tiebreak, NULLs last).
--
-- The column is nullable, and NULL is a defined state: "unkeyed", which sorts
-- LAST. In practice every stored row is keyed — `add` mints a trailing key,
-- `reorder` sets one, and an init backfill (DbCaptureStore.backfillSortKeys)
-- keys legacy rows in createdAt order so they keep their place instead of
-- sinking below newly-keyed adds. So NULL is only ever transient (a legacy row
-- before the backfill) or the client's optimistic just-added row, which sorts
-- last until the server assigns its key on reconcile. The whole stack tolerates
-- NULL (sorts last) rather than depending on its absence.
--
-- Not NOT NULL because it can't be: ADD COLUMN on a populated table cannot be
-- NOT NULL without a default, and a valid fractional key cannot be produced in
-- SQL (its charset is base-62; ISO timestamps / zero-padded numbers contain
-- characters generateKeyBetween rejects, and mixing them corrupts later key
-- math). Making it physically NOT NULL later would need a full table rebuild for
-- negligible benefit, so the column stays nullable by design.
ALTER TABLE "captures" ADD COLUMN "sortKey" TEXT;

-- Serves the open-list order (WHERE processedAt IS NULL ORDER BY sortKey). The
-- existing captures_inbox index on createdAt stays for the createdAt tiebreak.
CREATE INDEX "captures_sort" ON "captures" ("sortKey") WHERE "processedAt" IS NULL;
