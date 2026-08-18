-- When Zero last woke this sleeper. Null until the first wake. The wake episode
-- guard compares it against lastActiveAt so one message is sent per sleep
-- episode, whether it fires from the deadline or the admin backfill (see
-- docs/wake-sleepers.md).
ALTER TABLE "user_settings" ADD COLUMN "wokeAt" TEXT DEFAULT NULL;
