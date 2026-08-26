-- GTD reframe: the entry point is a capture Inbox, not a todo list. Rename the
-- table and the completion column to the locked vocabulary (Capture / Inbox /
-- Process). Forward-only; 0037/0038 stay as they applied. Cloudflare DO SQLite
-- supports RENAME TO / RENAME COLUMN. `processedAt` NULL = still in the Inbox.
ALTER TABLE "todos" RENAME TO "captures";
ALTER TABLE "captures" RENAME COLUMN "doneAt" TO "processedAt";
