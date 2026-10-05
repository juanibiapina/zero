-- Mark a todo done: a nullable completion timestamp. NULL means open; a value
-- is when it was completed. The open list is the rows where doneAt IS NULL.
ALTER TABLE "todos" ADD COLUMN "doneAt" TEXT;
