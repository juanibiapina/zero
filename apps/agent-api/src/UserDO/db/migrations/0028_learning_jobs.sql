-- One row per learning job, so a job's input range is frozen once and its
-- completion is idempotent.
--
-- `highWaterMessageId` is the newest message the job covers, chosen when the job
-- starts. Messages that arrive later belong to the next job, never to this one:
-- otherwise a job would consolidate messages its prompt never contained. The
-- completion stamp is applied only up to that id, and a repeated completion for
-- the same job does nothing.
CREATE TABLE "learning_jobs" (
  "jobId" TEXT PRIMARY KEY,
  "highWaterMessageId" INTEGER NOT NULL,
  "startedAt" TEXT NOT NULL,
  "completedAt" TEXT DEFAULT NULL
);
