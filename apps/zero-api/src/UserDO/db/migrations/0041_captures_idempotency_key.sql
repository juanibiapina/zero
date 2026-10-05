-- Client-supplied per-write idempotency key for captures. The offline outbox
-- reuses the same key on every retry/replay, so the DO can dedupe a lost-ACK
-- retry instead of double-inserting. Forward-only; 0037-0040 stay untouched.
ALTER TABLE "captures" ADD COLUMN "idempotencyKey" TEXT;

-- Partial unique index: many NULLs allowed (legacy rows, keyless adds), but a
-- key can back at most one capture. Backstop under the store's read-then-insert.
CREATE UNIQUE INDEX "captures_idempotency_key"
  ON "captures" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
