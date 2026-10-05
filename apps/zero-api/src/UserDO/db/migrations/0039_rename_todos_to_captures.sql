-- GTD reframe: rename todos -> captures, doneAt -> processedAt. Forward-only;
-- 0037/0038 stay as they applied. DO SQLite supports RENAME TO / RENAME COLUMN.
ALTER TABLE "todos" RENAME TO "captures";
ALTER TABLE "captures" RENAME COLUMN "doneAt" TO "processedAt";
