-- Schedules: one row per thing the user asked Zero to do later, once or
-- repeatedly. `prompt` is an instruction to Zero's future self, enqueued as a
-- pending message when the row comes due, so a fire is an ordinary turn.
--
-- `pattern` is either a five-field cron expression or an ISO-8601 local
-- datetime (a one-shot), evaluated in `timezone`. The zone is snapshotted at
-- creation and never re-read from user settings: moving country must not
-- silently move every existing schedule.
--
-- `nextDueAt` is epoch milliseconds, NULL once the row is retired. It is the
-- only column read on the firing path, hence the index.
CREATE TABLE "schedules" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id"),
  "prompt" TEXT NOT NULL,
  "pattern" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "nextDueAt" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TEXT NOT NULL,
  "lastFiredAt" TEXT DEFAULT NULL
);
--> statement-breakpoint
CREATE INDEX "schedules_next_due_at" ON "schedules" ("nextDueAt");
