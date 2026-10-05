-- DATA LOSS: TaskDO is the sole todo authority. These UserDO tables are inert
-- remnants of the retired todo store and contain no data used by current code.
DROP TABLE IF EXISTS "waiting_conditions";
DROP TABLE IF EXISTS "tasks";
DROP TABLE IF EXISTS "projects";
