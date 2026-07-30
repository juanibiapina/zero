-- External writes (sending mail, creating a calendar event) cannot be replayed
-- the way a topic write can: the request either left or it did not, and nothing
-- outside Google can tell us which. One row per such call, keyed by the model's
-- own tool_use id, claimed BEFORE the request leaves and completed with the
-- serialized result after it returns.
--
-- A resumed turn replays the same tool_use id, so a row in 'started' means "an
-- earlier attempt fired this and never recorded the outcome": the resume must
-- report that uncertainty instead of sending twice. A 'completed' row hands back
-- the recorded result without another call.
CREATE TABLE "external_calls" (
  "toolUseId" TEXT PRIMARY KEY,
  "tool" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" TEXT DEFAULT NULL,
  "startedAt" TEXT NOT NULL,
  "completedAt" TEXT DEFAULT NULL
);
