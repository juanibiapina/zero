-- Retire the captures idempotencyKey. The client now mints the capture id and
-- re-sends it verbatim on every retry/replay, so the primary key itself dedupes
-- a lost-ACK double-insert; the separate key and its index are redundant.
-- Forward-only; drop the index before the column it covers.
DROP INDEX IF EXISTS "captures_idempotency_key";
ALTER TABLE "captures" DROP COLUMN "idempotencyKey";
